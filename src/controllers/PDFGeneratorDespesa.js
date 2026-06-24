var ejs = require('ejs');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/Despesa');
const ChecklistCompItem = require('../model/DespesaItem');
const Usuario = require('../model/Usuario');
var path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');
const { runPdfJob, enablePdfImageOptimization } = require('../utils/pdfQueue');

const MAX_SELECTED_DESPESAS = 50;
const MAX_FOTOS_PER_PDF = 240;
const IMAGE_LOAD_TIMEOUT_MS = 120000;

async function waitForImagesToSettle(page, timeoutMs = IMAGE_LOAD_TIMEOUT_MS) {
    await page.evaluate((maxWait) => {
        const images = Array.from(document.images || []);

        if (images.length === 0) {
            return Promise.resolve();
        }

        const imagePromises = images.map((img) => {
            if (img.complete) {
                return Promise.resolve();
            }

            return new Promise((resolve) => {
                const done = () => resolve();
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
            });
        });

        const timeoutPromise = new Promise((resolve) => {
            setTimeout(resolve, maxWait);
        });

        return Promise.race([
            Promise.all(imagePromises),
            timeoutPromise
        ]);
    }, timeoutMs);
}

module.exports = {

    async create(req, res){
        return runPdfJob(async () => {

            try {
                const checkList = await ChecklistComp.findOne({ _id: req.params.id });
                const checkListItens = await ChecklistCompItem.find({ iddespesa: req.params.id });
                var pdflocation = '';

                if (checkList) {
                    if (checkList.idrequester) {
                        const requester = await Usuario.findOne({ _id: checkList.idrequester });
                        if (requester && requester.nome) {
                            checkList.nomerequester = String(requester.nome).trim().toUpperCase();
                        }
                    }
                    if (checkList.idaprovador) {
                        const approver = await Usuario.findOne({ _id: checkList.idaprovador });
                        if (approver && approver.nome) {
                            checkList.nomeaprovador = String(approver.nome).trim().toUpperCase();
                        }
                    }
                }

                const dataentrada = new Date(checkList.dataentrada);
                let valor = 0;

                if(checkListItens.length > 0){
                    checkListItens.map((item) => {
                        if (String(item.status) !== "3") {
                            valor = valor + item.valor;
                        }
                    });
                }

                const html = await ejs.renderFile(
                    path.join(__dirname, '..' ,'templates', 'despesa.ejs'),
                    {
                        checklist: checkList,
                        checklistItens: checkListItens,
                        valor: new Intl.NumberFormat('pt-br',{style: 'currency', currency:'BRL'}).format(valor),
                        itensLength: checkListItens.length,
                        dataentrada: dataentrada.toLocaleDateString('pt-BR', {timeZone: 'UTC'})
                    }
                );

                let browser;
                let page;

                try {
                    const remotePath = process.env.CHROMIUM_REMOTE_EXEC_PATH;

                    if (!remotePath) {
                        throw new Error('CHROMIUM_REMOTE_EXEC_PATH não configurado');
                    }

                    browser = await puppeteer.launch({
                        args: chromium.args,
                        defaultViewport: chromium.defaultViewport,
                        executablePath: await chromium.executablePath(remotePath),
                        headless: chromium.headless,
                        protocolTimeout: 600000
                    });

                    page = await browser.newPage();

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
                        timeout: 600000
                    });

                    await page.close();
                    page = null;

                    await browser.close();
                    browser = null;

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
                    if (page) {
                        try {
                            await page.close();
                        } catch (pageErr) {
                            console.log(pageErr);
                        }
                    }

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
            } catch (err) {
                console.log("Erro geral: " + err);
                return res.status(400).send({ error: "Erro ao processar a solicitação" });
            }
        });
    },

    async createSelectedPhotos(req, res) {
        return runPdfJob(async () => {
            try {
                const startedAt = Date.now();
                const selectedItems = Array.isArray(req.body?.selectedItems) ? req.body.selectedItems : [];

                if (selectedItems.length === 0) {
                    return res.status(400).send({ error: "Nenhum relatório selecionado" });
                }

                const ids = selectedItems
                    .map((id) => String(id))
                    .filter((id) => /^[a-fA-F0-9]{24}$/.test(id));

                if (ids.length === 0) {
                    return res.status(400).send({ error: "IDs inválidos" });
                }

                if (ids.length > MAX_SELECTED_DESPESAS) {
                    return res.status(422).send({
                        error: `Selecione no máximo ${MAX_SELECTED_DESPESAS} despesas por exportação em PDF`
                    });
                }

                const escapeHtml = (value) =>
                    String(value ?? "")
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/\"/g, "&quot;")
                        .replace(/'/g, "&#39;");

                const despesas = await ChecklistComp.find({ _id: { $in: ids } }).sort({ numero: 1 }).lean();

                if (despesas.length !== ids.length) {
                    const existingIds = despesas.map((item) => String(item._id));
                    const missingIds = ids.filter((id) => !existingIds.includes(id));
                    return res.status(400).send({
                        error: "Uma ou mais despesas selecionadas não foram encontradas",
                        missingIds
                    });
                }

                const itens = await ChecklistCompItem.find({ iddespesa: { $in: despesas.map((item) => item._id) } }).lean();
                const itensByDespesaId = itens.reduce((acc, item) => {
                    const despesaId = String(item.iddespesa);
                    if (!acc[despesaId]) {
                        acc[despesaId] = [];
                    }
                    acc[despesaId].push(item);
                    return acc;
                }, {});

                const despesasWithItems = despesas.map((d) => ({
                    despesa: d,
                    itens: itensByDespesaId[String(d._id)] || []
                }));

                let html = `
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      color: #202124;
      background: #ffffff;
    }
    .photo-sheet {
      page-break-after: always;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .photo-sheet:last-child {
      page-break-after: auto;
    }

    .sheet-header {
      margin: 0 0 4mm 0;
      padding: 3mm 4mm;
      border: 1px solid #d5dde5;
      border-left: 5px solid #23527c;
      border-radius: 8px;
      background: #f8fbfd;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .sheet-title {
      margin: 0;
      color: #23527c;
      font-size: 13px;
      font-weight: bold;
      line-height: 1.25;
      text-transform: uppercase;
    }

    .photo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-auto-rows: 119mm;
      gap: 4mm;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .photo-cell {
      border: 1px solid #d5dde5;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(35, 82, 124, 0.12);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .img-wrap {
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2mm;
      border-bottom: 1px solid #d5dde5;
      background: #f5f7f9;
      overflow: hidden;
    }

    .photo-cell img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }

    .caption {
      min-height: 23mm;
      padding: 2.5mm 3mm 3mm;
      font-size: 9.5px;
      color: #3d4349;
      overflow: hidden;
      line-height: 1.25;
      display: -webkit-box;
      -webkit-line-clamp: 6;
      -webkit-box-orient: vertical;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .caption strong {
      color: #23527c;
    }

    .caption-line {
      display: block;
      margin-bottom: 1mm;
    }
  </style>
</head>
<body>
`;

                const fotosExportacao = [];
                const skippedDespesas = [];

                for (const entry of despesasWithItems) {
                    const d = entry.despesa;
                    const itens = Array.isArray(entry.itens) ? entry.itens : [];
                    const dataentrada = d?.dataentrada ? new Date(d.dataentrada).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '';

                    const fotos = itens.filter((it) => !!it?.foto);
                    if (fotos.length === 0) {
                        skippedDespesas.push({
                            id: String(d._id),
                            numero: d.numero
                        });
                        continue;
                    }

                    for (const foto of fotos) {
                        fotosExportacao.push({
                            despesa: d,
                            item: foto,
                            dataentrada
                        });
                    }
                }

                if (fotosExportacao.length === 0) {
                    return res.status(422).send({
                        error: "Nenhuma foto disponível nas despesas selecionadas",
                        skippedCount: skippedDespesas.length,
                        skippedItems: skippedDespesas
                    });
                }

                if (fotosExportacao.length > MAX_FOTOS_PER_PDF) {
                    return res.status(422).send({
                        error: `Selecione no máximo ${MAX_FOTOS_PER_PDF} fotos por exportação em PDF`,
                        photoCount: fotosExportacao.length
                    });
                }

                const fotoPages = [];
                for (let i = 0; i < fotosExportacao.length; i += 4) {
                    fotoPages.push(fotosExportacao.slice(i, i + 4));
                }

                for (const pageFotos of fotoPages) {
                    html += `<div class="photo-sheet">`;
                    html += `<div class="sheet-header">`;
                    html += `<p class="sheet-title">Exportar Fotos PDF - Despesas</p>`;
                    html += `</div>`;
                    html += `<div class="photo-grid">`;

                    for (const fotoEntry of pageFotos) {
                        const d = fotoEntry.despesa;
                        const it = fotoEntry.item;
                        const caption = [it?.descr, it?.categoriaText].filter(Boolean).join(" - ");

                        html += `<div class="photo-cell">`;
                        html += `<div class="img-wrap"><img src="${escapeHtml(it.foto)}" /></div>`;
                        html += `<div class="caption">`;
                        html += `<span class="caption-line"><strong>Requisição:</strong> ${escapeHtml(d?.numero ?? "")}</span>`;
                        html += `<span class="caption-line"><strong>Requisitante:</strong> ${escapeHtml(d?.nomerequester ?? "")}</span>`;
                        html += `<span class="caption-line"><strong>Data:</strong> ${escapeHtml(fotoEntry.dataentrada)}</span>`;
                        if (caption) {
                            html += `<span class="caption-line"><strong>Descrição:</strong> ${escapeHtml(caption)}</span>`;
                        }
                        html += `</div>`;
                        html += `</div>`;
                    }

                    html += `</div>`;
                    html += `</div>`;
                }

                html += `</body></html>`;

                let browser;
                let page;

                try {
                    const remotePath = process.env.CHROMIUM_REMOTE_EXEC_PATH;

                    if (!remotePath) {
                        throw new Error('CHROMIUM_REMOTE_EXEC_PATH não configurado');
                    }

                    browser = await puppeteer.launch({
                        args: chromium.args,
                        defaultViewport: chromium.defaultViewport,
                        executablePath: await chromium.executablePath(remotePath),
                        headless: chromium.headless,
                        protocolTimeout: 600000
                    });

                    page = await browser.newPage();
                    await enablePdfImageOptimization(page);

                    await page.setContent(html, { waitUntil: 'domcontentloaded' });
                    await waitForImagesToSettle(page);

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
                        timeout: 600000
                    });

                    await page.close();
                    page = null;

                    await browser.close();
                    browser = null;

                    const s3 = new AWS.S3({
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                    });

                    const filename = `despesas_fotos_${Date.now()}.pdf`;

                    const params = {
                        Bucket: process.env.S3_BUCKET,
                        Key: filename,
                        Body: pdfBuffer,
                        ContentType: 'application/pdf'
                    };

                    const data = await s3.upload(params).promise();

                    console.log("[PDF Despesa Fotos] sucesso", {
                        selectedCount: ids.length,
                        photoCount: fotosExportacao.length,
                        skippedCount: skippedDespesas.length,
                        elapsedMs: Date.now() - startedAt
                    });

                    return res.status(200).send({
                        success: true,
                        pdflink: data.Location,
                        selectedCount: ids.length,
                        photoCount: fotosExportacao.length,
                        skippedCount: skippedDespesas.length,
                        skippedItems: skippedDespesas
                    });
                } catch (err) {
                    if (page) {
                        try {
                            await page.close();
                        } catch (pageErr) {
                            console.log(pageErr);
                        }
                    }

                    if (browser) {
                        try {
                            await browser.close();
                        } catch (closeErr) {
                            console.log(closeErr);
                        }
                    }

                    console.log("[PDF Despesa Fotos] erro", {
                        selectedCount: ids.length,
                        elapsedMs: Date.now() - startedAt,
                        err
                    });
                    return res.status(400).send({ error: "Erro ao gerar PDF" });
                }
            } catch (err) {
                console.log("[PDF Despesa Fotos] erro geral:", err);
                return res.status(400).send({ error: "Erro ao processar a solicitação" });
            }
        });
    }
};
