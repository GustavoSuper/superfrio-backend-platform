var ejs = require('ejs');
const AWS = require('aws-sdk');
const ChecklistPit = require('../model/ChecklistPit');
const ChecklistPitItem = require('../model/ChecklistPitItem');
var path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const { enablePdfImageOptimization } = require('../utils/pdfQueue');

module.exports = {

    async create(req, res){
        
        try {
            const checkList = await ChecklistPit.findOne({ _id: req.params.id });
            const checkListItens = await ChecklistPitItem.find({ idchecklistpit: req.params.id }).sort({ordemitem: 1});
            var pdflocation = '';
            const dataentrada = new Date(checkList.dataentrada);

            ejs.renderFile(
                path.join(__dirname, '..' ,'templates', 'pitstop-instalacao.ejs'),
                {
                    checklist: checkList,
                    checklistItens: checkListItens,
                    dataentrada: dataentrada.toLocaleDateString('pt-BR', {timeZone: 'UTC'})
                },
                async (err, html) => {
                    if(err){
                        console.log("Erro ao renderizar HTML: " + err);
                        return res.status(400).send({ error: "Erro ao gerar HTML" });
                    } else {
                        let browser;

                        try {
                            const remotePath = process.env.CHROMIUM_REMOTE_EXEC_PATH;

                            if (!remotePath) {
                                throw new Error('CHROMIUM_REMOTE_EXEC_PATH não configurado');
                            }

                            browser = await puppeteer.launch({
                                args: chromium.args,
                                defaultViewport: chromium.defaultViewport,
                                executablePath: await chromium.executablePath(remotePath),
                                headless: chromium.headless
                            });

                            const page = await browser.newPage();

                            await enablePdfImageOptimization(page);

                            await page.setContent(html, {
                                waitUntil: 'networkidle0'
                            });

                            const pdfBuffer = await page.pdf({
                                format: "A4",
                                printBackground: true,
                                timeout: 100000
                            });

                            await browser.close();

                            const s3 = new AWS.S3({
                                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                            });

                            const filename = checkList._id + ".pdf";

                            const params = {
                                Bucket: process.env.S3_BUCKET,
                                Key: filename,
                                Body: pdfBuffer,
                                ContentType: 'application/pdf'
                            };

                            const data = await s3.upload(params).promise();

                            pdflocation = data.Location;
                            console.log(`File uploaded successfully. ${data.Location}`);

                            await ChecklistPit.updateOne(
                                { _id: checkList._id },
                                { pdflink: pdflocation }
                            );

                            return res.status(200).send({ success: true, pdflink: pdflocation });
                        } catch(err){
                            if (browser) {
                                try {
                                    await browser.close();
                                } catch (closeErr) {
                                    console.log(closeErr);
                                }
                            }

                            console.log("Erro: " + err);
                            return res.status(400).send({ error: "Erro ao gerar PDF" });
                        }
                    }
                }
            );
        } catch (err) {
            console.log("Erro geral: " + err);
            return res.status(400).send({ error: "Erro ao processar a solicitação" });
        }
    }
};