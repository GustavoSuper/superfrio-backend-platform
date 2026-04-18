const ejs = require('ejs');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/ChecklistComp');
const ChecklistCompItem = require('../model/ChecklistCompItem');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const { runPdfJob } = require('../utils/pdfQueue');

const MAX_PDF_RETRIES = 3;

function isRetryablePdfError(err) {
    const message = (err && err.message ? err.message : '').toLowerCase();
    return (
        message.includes('io.read') ||
        message.includes('target closed') ||
        message.includes('page crashed') ||
        message.includes('protocol error')
    );
}

module.exports = {
    async create(req, res) {
        return runPdfJob(async () => {
            let browser;
            let page;

            try {
                const checkList = await ChecklistComp.findOne({ _id: req.params.id })
                    .populate('idcliente')
                    .populate('idcompressor')
                    .populate('idfabricante');

                const checkListItens = await ChecklistCompItem
                    .find({ idchecklistcomp: req.params.id })
                    .sort({ ordemitem: 1 });

                const dataentrada = new Date(checkList.dataentrada);

                const html = await ejs.renderFile(
                    path.join(__dirname, '..', 'templates', 'compressor.ejs'),
                    {
                        checklist: checkList,
                        checklistItens: checkListItens,
                        itensLength: checkListItens.length,
                        dataentrada: dataentrada.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
                    }
                );

                const remotePath = process.env.CHROMIUM_REMOTE_EXEC_PATH;

                if (!remotePath) {
                    throw new Error('CHROMIUM_REMOTE_EXEC_PATH não configurado');
                }

                let pdfBuffer;

                // 🔁 Tentativas de geração
                for (let attempt = 1; attempt <= MAX_PDF_RETRIES; attempt++) {
                    try {
                        console.log(`[PDF] tentativa ${attempt}/${MAX_PDF_RETRIES} id=${req.params.id}`);

                        browser = await puppeteer.launch({
                            args: chromium.args,
                            defaultViewport: chromium.defaultViewport,
                            executablePath: await chromium.executablePath(remotePath),
                            headless: chromium.headless,
                            protocolTimeout: 600000
                        });

                        page = await browser.newPage();

                        await page.setContent(html, {
                            waitUntil: 'networkidle0'
                        });

                        pdfBuffer = await page.pdf({
                            format: "A4",
                            printBackground: true,
                            displayHeaderFooter: true,
                            headerTemplate: `<div></div>`,
                            footerTemplate: `
                                <div style="text-align:center;font-size:10px;">
                                    Página <span class="pageNumber"></span>
                                </div>
                            `,
                            margin: {
                                top: "10mm",
                                bottom: "25mm",
                                left: "10mm",
                                right: "10mm"
                            },
                            timeout: 600000
                        });

                        break; // sucesso
                    } catch (err) {
                        const retryable = isRetryablePdfError(err);
                        console.log(`[PDF] erro tentativa ${attempt} retryable=${retryable}`);
                        console.log(err);

                        if (!retryable || attempt === MAX_PDF_RETRIES) {
                            throw err;
                        }
                    } finally {
                        if (page) {
                            try { await page.close(); } catch (e) {}
                            page = null;
                        }

                        if (browser) {
                            try { await browser.close(); } catch (e) {}
                            browser = null;
                        }
                    }
                }

                // 🚨 segurança extra
                if (!pdfBuffer) {
                    throw new Error('Falha ao gerar PDF após múltiplas tentativas');
                }

                // ☁️ Upload S3
                const s3 = new AWS.S3({
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                });

                const filename = checkList._id + ".pdf";

                const data = await s3.upload({
                    Bucket: process.env.S3_BUCKET,
                    Key: filename,
                    Body: pdfBuffer,
                    ContentType: 'application/pdf'
                }).promise();

                await ChecklistComp.updateOne(
                    { _id: checkList._id },
                    { pdflink: data.Location }
                );

                return res.status(200).send({
                    success: true,
                    pdflink: data.Location
                });

            } catch (err) {
                console.log("Erro:", err);

                return res.status(400).send({
                    error: "Erro ao gerar PDF"
                });
            }
        });
    }
};