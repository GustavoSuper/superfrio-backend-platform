var pdf = require('html-pdf');
var ejs = require('ejs');
const fs = require("fs");
const AWS = require('aws-sdk');
const ChecklistPit = require('../model/ChecklistPit');
const ChecklistPitItem = require('../model/ChecklistPitItem');
var path = require('path');

module.exports = {

    async create(req, res){
        
        const checkList = await ChecklistPit.findOne({ _id: req.params.id });
        const checkListItens = await ChecklistPitItem.find({ idchecklistpit: req.params.id }).sort({ordemitem: 1});
        var pdflocation = '';
        const dataentrada = new Date(checkList.dataentrada);
        ejs.renderFile(path.join(__dirname, '..' ,'templates', 'pitstop-instalacao.ejs'), {checklist: checkList, checklistItens: checkListItens, dataentrada: dataentrada.toLocaleDateString('pt-BR', {timeZone: 'UTC'})}, (err, html) => {
            if(err){
                console.log("Erro ao renderizar HTML: " + err);
                return res.status(400).send({ error: "Erro ao gerar HTML" });
            } else {
                pdf.create(html, {timeout: '100000'}).toBuffer((err, buffer) => {
                    if(err){
                        console.log("Erro: " + err)
                        return res.status(400).send({
                            error: "Erro ao gerar PDF",
                            details: process.env.NODE_ENV === 'production' ? undefined : String(err)
                        });
                    } else {
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
                            await ChecklistPit.updateOne({ _id: checkList._id },{pdflink: pdflocation});
                            return res.status(200).send({ success: true, pdflink: pdflocation});
                        });
                    }
                });       
            }
        });
    }
};

