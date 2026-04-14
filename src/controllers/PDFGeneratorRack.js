const ejs = require('ejs');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/ChecklistRack');
const ChecklistCompItem = require('../model/ChecklistRackItem');
const path = require('path');
const mongoose = require('mongoose');

module.exports = {
  async create(req, res) {
    let browser = null;

    try {
      const { id } = req.params;

      console.log('[generatePDFRack] Iniciando geração', {
        id,
        method: req.method,
        url: req.originalUrl
      });

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).send({ error: 'ID inválido' });
      }

      const checkList = await ChecklistComp.findOne({ _id: id }).populate('idcliente');

      if (!checkList) {
        return res.status(404).send({ error: 'Checklist não encontrado' });
      }

      const checkListItens = await ChecklistCompItem
        .find({ idchecklistrack: id })
        .sort({ ordemitem: 1 });

      const dataentrada = checkList.dataentrada
        ? new Date(checkList.dataentrada)
        : new Date();

      const templatePath = path.join(__dirname, '..', 'templates', 'rack.ejs');

      const html = await ejs.renderFile(templatePath, {
        checklist: checkList,
        checklistItens: checkListItens,
        itensLength: checkListItens.length,
        dataentrada: dataentrada.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
      });

      console.log('[generatePDFRack] HTML renderizado', {
        checklistId: checkList._id,
        itensLength: checkListItens.length,
        templatePath
      });

      const launchOptions = {
        args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      };

      browser = await puppeteer.launch(launchOptions);

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="font-size:8px;width:100%;text-align:center;">
            <span class="pageNumber"></span>
          </div>
        `,
        margin: { top: '10mm', bottom: '25mm', left: '10mm', right: '10mm' }
      });

      console.log('[generatePDFRack] PDF gerado', {
        bufferSize: buffer ? buffer.length : 0
      });

      if (
        !process.env.AWS_ACCESS_KEY_ID ||
        !process.env.AWS_SECRET_ACCESS_KEY ||
        !process.env.AWS_REGION ||
        !process.env.S3_BUCKET
      ) {
        return res.status(400).send({
          error: 'Configuração AWS incompleta'
        });
      }

      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION
      });

      const filename = `${checkList._id}.pdf`;

      const params = {
        Bucket: process.env.S3_BUCKET,
        Key: filename,
        Body: buffer,
        ContentType: 'application/pdf'
      };

      if (process.env.S3_PUBLIC_READ === 'true') {
        params.ACL = 'public-read';
      }

      const data = await s3.upload(params).promise();

      console.log('[generatePDFRack] Upload concluído', {
        location: data.Location
      });

      await ChecklistComp.updateOne(
        { _id: checkList._id },
        { pdflink: data.Location }
      );

      return res.status(200).send({
        success: true,
        pdflink: data.Location
      });
    } catch (err) {
      console.log('[generatePDFRack] Erro geral:', err);
      return res.status(500).send({
        error: 'Erro interno ao gerar PDF',
        details: process.env.NODE_ENV === 'production' ? undefined : String(err)
      });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
};