var ejs = require('ejs');
const puppeteer = require('puppeteer');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/ChecklistComp');
const ChecklistCompItem = require('../model/ChecklistCompItem');
var path = require('path');

module.exports = {

    async create(req, res){

        const checkList = await ChecklistComp.findOne({ _id: req.params.id }).populate('idcliente').populate('idcompressor').populate('idfabricante');
        const checkListItens = await ChecklistCompItem.find({ idchecklistcomp: req.params.id }).sort({ordemitem: 1});
        var pdflocation = '';
        const dataentrada = new Date(checkList.dataentrada);
        ejs.renderFile(path.join(__dirname, '..' ,'templates', 'compressor.ejs'), {checklist: checkList, checklistItens: checkListItens, itensLength: checkListItens.length, dataentrada: dataentrada.toLocaleDateString('pt-BR', {timeZone: 'UTC'})}, async (err, html) => {
            if(err){
                console.log("Erro ao renderizar HTML: " + err);
                return res.status(400).send({ error: "Erro ao gerar HTML" });
            } else {
                let buffer;
                let browser;

                try {
                    browser = await puppeteer.launch({
                        args: ['--no-sandbox', '--disable-setuid-sandbox'],
                        headless: 'new'
                    });

                    const page = await browser.newPage();
                    await page.setContent(html, { waitUntil: 'networkidle0' });
                    buffer = await page.pdf({
                        format: 'A4',
                        printBackground: true,
                        displayHeaderFooter: true,
                        headerTemplate: '<div></div>',
                        footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;"><span class="pageNumber"></span></div>',
                        margin: { top: '10mm', bottom: '25mm', left: '10mm', right: '10mm' }
                    });
                } catch (err) {
                    console.log("Erro: " + err)
                    return res.status(400).send({
                        error: "Erro ao gerar PDF",
                        details: process.env.NODE_ENV === 'production' ? undefined : String(err)
                    });
                } finally {
                    if (browser) {
                        await browser.close();
                    }
                }

                const s3 = new AWS.S3({
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    region: process.env.AWS_REGION
                  });
                const filename = checkList._id +".pdf";

                const params = {
                    Bucket: process.env.S3_BUCKET,
                    Key: filename,
                    Body: buffer,
                    ContentType: 'application/pdf'
                };

                if (process.env.S3_PUBLIC_READ === 'true') {
                    params.ACL = 'public-read';
                }

                s3.upload(params, async function(err, data) {
                    if (err) {
                        console.log(err);
                        return res.status(400).send({
                            error: "Erro ao salvar na AWS",
                            details: process.env.NODE_ENV === 'production' ? undefined : String(err)
                        });
                    }
                    pdflocation = data.Location;
                    console.log(`File uploaded successfully. ${data.Location}`);
                    await ChecklistComp.updateOne({ _id: checkList._id },{pdflink: pdflocation});
                    return res.status(200).send({ success: true, pdflink: pdflocation});
                });
            }
        });
    }
};

