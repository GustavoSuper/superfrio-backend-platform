var ejs = require('ejs');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/ChecklistRack');
const ChecklistCompItem = require('../model/ChecklistRackItem');
var path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const { enablePdfImageOptimization } = require('../utils/pdfQueue');

module.exports = {

    async create(req, res){

        try {
            const checkList = await ChecklistComp.findOne({ _id: req.params.id }).populate('idcliente');
            const checkListItens = await ChecklistCompItem.find({ idchecklistrack: req.params.id }).sort({ordemitem: 1});
            var pdflocation = '';
            const dataentrada = new Date(checkList.dataentrada);
            // if(checkList.compressores.length > 0){
            //     for (const item of checkList.compressores) {
                
            //     }
            // }

            ejs.renderFile(
                path.join(__dirname, '..' ,'templates', 'rack.ejs'),
                {
                    checklist: checkList,
                    checklistItens: checkListItens,
                    itensLength: checkListItens.length,
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
                                displayHeaderFooter: true,
                                headerTemplate: `<div style="width: 100%; font-size: 10px; padding: 0 20px;"></div>`,
                                footerTemplate: `
                                    <div style="width: 100%; font-size: 10px; text-align: center; padding: 0 20px;">
                                        <span>Página <span class="pageNumber"></span></span>
                                    </div>
                                `,
                                margin: {
                                    top: "10mm",
                                    bottom: "25mm",
                                    left: "10mm",
                                    right: "10mm"
                                },
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

                            await ChecklistComp.updateOne(
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