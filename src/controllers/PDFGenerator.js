var pdf = require('html-pdf');
var ejs = require('ejs');
const AWS = require('aws-sdk');
const ChecklistComp = require('../model/ChecklistComp');
const ChecklistCompItem = require('../model/ChecklistCompItem');
const path = require('path');
const mongoose = require('mongoose');

module.exports = {
  async create(req, res) {
    try {
      const { id } = req.params;

      console.log('[generatePDF] Iniciando geração', {
        id,
        method: req.method,
        url: req.originalUrl,
        hasBody: !!req.body
      });

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        console.log('[generatePDF] ID inválido:', id);
        return res.status(400).send({ error: 'ID inválido' });
      }

      const checkList = await ChecklistComp.findOne({ _id: id })
        .populate('idcliente')
        .populate('idcompressor')
        .populate('idfabricante');

      if (!checkList) {
        console.log('[generatePDF] Checklist não encontrado para id:', id);
        return res.status(404).send({ error: 'Checklist não encontrado' });
      }

      const checkListItens = await ChecklistCompItem.find({ idchecklistcomp: id }).sort({ ordemitem: 1 });

      const dataentrada = checkList.dataentrada
        ? new Date(checkList.dataentrada)
        : new Date();

      const templatePath = path.join(__dirname, '..', 'templates', 'compressor.ejs');

      console.log('[generatePDF] Dados carregados', {
        checklistId: checkList._id,
        itensLength: checkListItens.length,
        templatePath
      });

      ejs.renderFile(
        templatePath,
        {
          checklist: checkList,
          checklistItens: checkListItens,
          itensLength: checkListItens.length,
          dataentrada: dataentrada.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        },
        (err, html) => {
          if (err) {
            console.log('[generatePDF] Erro ao renderizar HTML:', err);
            return res.status(400).send({
              error: 'Erro ao gerar HTML',
              details: process.env.NODE_ENV === 'production' ? undefined : String(err)
            });
          }

          console.log('[generatePDF] HTML renderizado com sucesso');

          pdf.create(html, {
            format: 'A4',
            timeout: '500000',
            footer: {
              height: '25mm',
              contents: '<p>Página {{page}}</p>'
            },
            header: {
              height: '10mm'
            }
          }).toBuffer((err, buffer) => {
            if (err) {
              console.log('[generatePDF] Erro ao gerar PDF:', err);
              return res.status(400).send({
                error: 'Erro ao gerar PDF',
                details: process.env.NODE_ENV === 'production' ? undefined : String(err)
              });
            }

            console.log('[generatePDF] PDF gerado com sucesso', {
              bufferSize: buffer ? buffer.length : 0
            });

            if (
              !process.env.AWS_ACCESS_KEY_ID ||
              !process.env.AWS_SECRET_ACCESS_KEY ||
              !process.env.AWS_REGION ||
              !process.env.S3_BUCKET
            ) {
              console.log('[generatePDF] Variáveis AWS ausentes', {
                hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
                hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
                region: process.env.AWS_REGION,
                bucket: process.env.S3_BUCKET
              });

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

            console.log('[generatePDF] Enviando PDF para S3', {
              bucket: params.Bucket,
              key: params.Key,
              region: process.env.AWS_REGION,
              publicRead: process.env.S3_PUBLIC_READ === 'true'
            });

            s3.upload(params, async function (err, data) {
              if (err) {
                console.log('[generatePDF] Erro ao salvar na AWS:', err);
                return res.status(400).send({
                  error: 'Erro ao salvar na AWS',
                  details: process.env.NODE_ENV === 'production' ? undefined : String(err)
                });
              }

              try {
                const pdflocation = data.Location;

                console.log('[generatePDF] Upload concluído com sucesso', {
                  location: pdflocation
                });

                await ChecklistComp.updateOne(
                  { _id: checkList._id },
                  { pdflink: pdflocation }
                );

                return res.status(200).send({
                  success: true,
                  pdflink: pdflocation
                });
              } catch (updateErr) {
                console.log('[generatePDF] Erro ao atualizar pdflink no Mongo:', updateErr);
                return res.status(500).send({
                  error: 'PDF enviado, mas houve erro ao atualizar o checklist',
                  details: process.env.NODE_ENV === 'production' ? undefined : String(updateErr)
                });
              }
            });
          });
        }
      );
    } catch (error) {
      console.log('[generatePDF] Erro geral no create:', error);
      return res.status(500).send({
        error: 'Erro interno ao gerar PDF',
        details: process.env.NODE_ENV === 'production' ? undefined : String(error)
      });
    }
  }
};