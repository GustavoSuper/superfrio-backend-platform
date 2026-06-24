const AWS = require("aws-sdk");
const Despesa = require('../model/Despesa');
const Usuario = require("../model/Usuario");
const DespesaAreaAppr = require("../model/DespesaAreaAppr");
const DespesaItem = require('../model/DespesaItem');
const nodemailer = require("nodemailer");
const hbs = require("nodemailer-express-handlebars");

const DELETABLE_DESPESA_STATUS = ["0", "1"];
const MAX_BULK_DELETE_COUNT = 10;

function getDespesaStatusLabel(status) {
  const normalizedStatus = String(status ?? "");
  if (normalizedStatus === "0") return "Rascunho";
  if (normalizedStatus === "1") return "Aguardando Aprovação";
  if (normalizedStatus === "2") return "Aprovado";
  if (normalizedStatus === "3") return "Reprovado";
  return "Desconhecido";
}

function getInvalidDeleteReason(despesa) {
  return `A despesa ${despesa.numero} está com status ${getDespesaStatusLabel(despesa.status)} e não pode ser removida.`;
}

function buildBulkDeleteConfirmationText(count) {
  return `REMOVER ${count} DESPESAS`;
}

function normalizeDespesaStatus(status) {
  return typeof status === "undefined" || status === null ? undefined : String(status);
}

function resolveApprovedAtByStatusTransition(previousStatus, nextStatus, currentApprovedAt) {
  if (typeof nextStatus === "undefined") {
    return undefined;
  }

  if (previousStatus !== "2" && nextStatus === "2") {
    return currentApprovedAt || new Date();
  }

  if (previousStatus === "2" && nextStatus !== "2") {
    return null;
  }

  return undefined;
}

async function deleteDespesaPdf(pdflink) {
  if (!pdflink || !process.env.S3_BUCKET) {
    return false;
  }

  try {
    const parsedUrl = new URL(pdflink);
    let key = decodeURIComponent(parsedUrl.pathname || "").replace(/^\/+/, "");

    if (!key) {
      return false;
    }

    const bucket = process.env.S3_BUCKET;
    const pathPrefix = `${bucket}/`;
    if (key.startsWith(pathPrefix)) {
      key = key.substring(pathPrefix.length);
    }

    const s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });

    await s3.deleteObject({
      Bucket: bucket,
      Key: key
    }).promise();

    return true;
  } catch (err) {
    console.log("Erro ao remover PDF da despesa:", err);
    return false;
  }
}

async function deleteDespesaCascade(despesa) {
  const deleteItemsResult = await DespesaItem.deleteMany({ iddespesa: despesa._id });
  const deleteDespesaResult = await Despesa.deleteOne({ _id: despesa._id });

  await deleteDespesaPdf(despesa.pdflink);

  return {
    deletedDespesaId: String(despesa._id),
    deletedItemsCount: deleteItemsResult.deletedCount ?? 0,
    deletedDespesaCount: deleteDespesaResult.deletedCount ?? deleteDespesaResult.n ?? 0
  };
}

async function deleteDespesasBatch(despesas) {
  const ids = despesas.map((item) => item._id);
  const deleteItemsResult = await DespesaItem.deleteMany({ iddespesa: { $in: ids } });
  const deleteDespesaResult = await Despesa.deleteMany({ _id: { $in: ids } });

  for (const despesa of despesas) {
    await deleteDespesaPdf(despesa.pdflink);
  }

  return {
    deletedIds: despesas.map((item) => String(item._id)),
    deletedCount: deleteDespesaResult.deletedCount ?? deleteDespesaResult.n ?? 0,
    deletedItemsCount: deleteItemsResult.deletedCount ?? 0
  };
}

module.exports = {
    async index(req, res){
        const { name, startDate, endDate } = req.query

        const now = new Date();
        const minDate = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));

        const filter = {
          dataentrada: { $gte: minDate }
        };

        if (name) {
          const regex = new RegExp(name, 'i');
          filter.nomerequester = regex;
        }

        if ((startDate && !endDate) || (!startDate && endDate)) {
          return res.status(400).json({ error: "Informe startDate e endDate" });
        }

        if (startDate && endDate) {
          const start = new Date(startDate);
          const end = new Date(endDate);
          const startClamped = start < minDate ? minDate : start;
          filter.dataentrada = { $gte: startClamped, $lte: end };
        }

        const returnGet = await Despesa.find(filter).sort({ dataentrada: -1, createdAt: -1 }).lean();
        const requesterIds = returnGet
          .map((despesa) => despesa.idrequester)
          .filter(Boolean);
        const requesters = await Usuario.find({ _id: { $in: requesterIds } }).select("_id area").lean();
        const requestersById = requesters.reduce((acc, requester) => {
          acc[String(requester._id)] = requester;
          return acc;
        }, {});

        const despesasWithArea = returnGet.map((despesa) => ({
          ...despesa,
          requesterArea: requestersById[String(despesa.idrequester)]?.area || ""
        }));

        // #region debug-point C:index-response
        fetch("http://192.168.0.111:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"despesa-approved-at",runId:"pre-fix",hypothesisId:"C",location:"DespesaController.js:156",msg:"[DEBUG] Retorno do GET /despesa montado",data:{count:despesasWithArea.length,approvedSample:despesasWithArea.slice(0,5).map((item)=>({id:String(item._id),numero:item.numero,status:normalizeDespesaStatus(item.status),approvedAt:item.approvedAt || null,nomeaprovador:item.nomeaprovador || null}))},ts:Date.now()})}).catch(()=>{});
        // #endregion

        return res.json(despesasWithArea)
    },

    async filter(req, res){

      const { name, startDate, endDate } = req.query;

      const filter = {};

      if (name) {
        filter.nomerequester = new RegExp(name, 'i');
      }

      if (startDate && endDate) {
        filter.updatedAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      const returnGet = await Despesa.find(filter);

      return res.json(returnGet)
    },

    async show(req, res){
        const returnShow = await Despesa.find({ _id: req.params.id });
        return res.json(returnShow)
    },

    async showByRequester(req, res){
        const returnShow = await Despesa.find({ idrequester: req.params.id }).sort({ createdAt: -1 });
        return res.json(returnShow)
    },

    async showByPending(req, res){
      const returnShow = await Despesa.find({ idaprovador: req.params.id, status: 1 });
      return res.json(returnShow)
    },

    async showByAppRej(req, res){
      const returnShow = await Despesa.find({ idaprovador: req.params.id, status: {$in: [2,3] }}).sort({ createdAt: -1 });
      return res.json(returnShow)
    },

    async countByRequester(req, res){
        const returnShow = await Despesa.countDocuments({ idrequester: req.params.id });
        return res.json(returnShow)
    },

    async countByPending(req, res){
      console.log(req.params.id);
      const returnShow = await Despesa.countDocuments({ status: 1, idaprovador: req.params.id });
      return res.json(returnShow)
  },

    async update(req, res){
        const allowedFields = [
          "dataentrada",
          "status",
          "pdflink",
          "idrequester",
          "nomerequester",
          "idaprovador",
          "nomeaprovador",
          "commaprovador",
          "obsgeral",
          "paid",
          "paidAt"
        ];
        const updateBody = {};

        allowedFields.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            updateBody[field] = req.body[field];
          }
        });

        const DespesaDocBeforeUpdate = await Despesa.findOne({ _id: req.params.id });
        if (!DespesaDocBeforeUpdate) {
          return res.status(404).json({ error: "Despesa não encontrada" });
        }

        const previousStatus = normalizeDespesaStatus(DespesaDocBeforeUpdate.status);
        const nextStatus = normalizeDespesaStatus(updateBody.status);
        const status = nextStatus;
        let messages = [];

        if (Object.keys(updateBody).length === 0) {
          return res.status(400).json({ error: "Nenhum campo válido para atualizar" });
        }

        if (typeof nextStatus !== "undefined") {
          updateBody.status = nextStatus;
        }

        const resolvedApprovedAt = resolveApprovedAtByStatusTransition(
          previousStatus,
          nextStatus,
          DespesaDocBeforeUpdate.approvedAt
        );

        // #region debug-point B:despesa-update-entry
        fetch("http://192.168.0.111:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"despesa-approved-at",runId:"pre-fix",hypothesisId:"B",location:"DespesaController.js:257",msg:"[DEBUG] Atualizacao direta da despesa recebida",data:{despesaId:String(req.params.id),previousStatus,nextStatus,approvedAtBefore:DespesaDocBeforeUpdate.approvedAt || null,resolvedApprovedAt:resolvedApprovedAt || null,payloadKeys:Object.keys(updateBody)},ts:Date.now()})}).catch(()=>{});
        // #endregion

        if (typeof resolvedApprovedAt !== "undefined") {
          updateBody.approvedAt = resolvedApprovedAt;
        }

        if (typeof updateBody.paid !== "undefined") {
          const paidValue = updateBody.paid === true || String(updateBody.paid) === "true";
          updateBody.paid = paidValue;
          if (paidValue) {
            updateBody.paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
          } else {
            updateBody.paidAt = null;
          }
        }

        if (typeof updateBody.paid === "undefined" && Object.prototype.hasOwnProperty.call(updateBody, "paidAt")) {
          updateBody.paidAt = updateBody.paidAt ? new Date(updateBody.paidAt) : null;
          updateBody.paid = !!updateBody.paidAt;
        }

        if (updateBody.paidAt && Number.isNaN(updateBody.paidAt.getTime())) {
          return res.status(400).json({ error: "Data de pagamento inválida" });
        }

        const returnUpdate = await Despesa.updateOne({ _id: req.params.id }, updateBody);
        const DespesaDoc = await Despesa.findOne({ _id: req.params.id });

        if (status == "1") { //envia para aprovação
          await DespesaItem.updateMany(
            { iddespesa: req.params.id, status: { $nin: ["2", "3"] } },
            { status: "1", commaprovadorItem: "" }
          );
          const requester = await Usuario.find({ _id: DespesaDoc.idrequester });
          const reqArea = await DespesaAreaAppr.find({_id: requester[0].idarea});
          let user = await Usuario.find({ _id: reqArea[0].idaprovador });

          if(requester[0]._id == user[0]._id) {
            const returnUpdate3 = await Despesa.updateOne(
              { _id: req.params.id },
              { idaprovador: user[0]._id, nomeaprovador: user[0].nome, status: 2, approvedAt: new Date() }
            );
            await DespesaItem.updateMany(
              { iddespesa: req.params.id, status: { $ne: "3" } },
              { status: "2" }
            );
            if (user) {
              let transporter = nodemailer.createTransport({
                host: process.env.EMAIL_SMTP,
                port: 465,
                auth: {
                  user: process.env.EMAIL_ACC,
                  pass: process.env.EMAIL_PWD,
                },
              });
      
              const options = {
                viewEngine: {
                  extName: ".handlebars",
                  partialsDir: "./views/",
                  defaultLayout: false,
                },
                viewPath: "./views/",
                extName: ".handlebars",
              };
      
              transporter.use("compile", hbs(options));
      
              for (const item of user) {
      
                try {
                  await transporter.sendMail({
                    from: "App Superfrio <app@superfriosr.com.br>",
                    to: item.email,
                    //to: "cleber.znch@gmail.com",
                    bcc: "cleber.znch@gmail.com",
                    subject:
                      "Seu Relatório de despesas foi aprovado",
                    text: "Seu Relatório de despesas foi aprovado",
                    template: "apprdespesaAprovado",
                    context: {
                      numero: DespesaDoc.numero,
                      requester: DespesaDoc.nomerequester,
                      //data: DespesaDoc.updatedAt,
                      aprovador: DespesaDoc.nomeaprovador,
                      obsgeral: DespesaDoc.obsgeral,
                      titulo: "Seu Relatório de despesas foi aprovado",
                      status: "Aprovado",
                      support_email: "mailto:app@superfriosr.com.br",
                    },
                  });
               } catch (err) {
                  console.log(err);
               } 
      
                if (item.pushToken) {
                  messages.push({
                    to: item.pushToken,
                    sound: "default",
                    priority: "high",
                    wake_screen: true,
                    show_in_foreground: true,
                    title: "Seu Relatório de despesas foi aprovado",
                    body:
                      "Seu Relatório de despesas foi aprovado. Revise pelo App Superfrio.",
                  });
                }
              }

              sendFinalEmail(DespesaDoc, messages, transporter);

            }
            return res.json(returnUpdate)
          }

          const returnUpdate2 = await Despesa.updateOne({ _id: req.params.id },{idaprovador: user[0]._id, nomeaprovador: user[0].nome});

            if (user) {
                let transporter = nodemailer.createTransport({
                  host: process.env.EMAIL_SMTP,
                  port: 465,
                  auth: {
                    user: process.env.EMAIL_ACC,
                    pass: process.env.EMAIL_PWD,
                  },
                });
        
                const options = {
                  viewEngine: {
                    extName: ".handlebars",
                    partialsDir: "./views/",
                    defaultLayout: false,
                  },
                  viewPath: "./views/",
                  extName: ".handlebars",
                };
        
                transporter.use("compile", hbs(options));
        
                for (const item of user) {
                  
                  try {
                    await transporter.sendMail({
                      from: "App Superfrio <app@superfriosr.com.br>",
                      to: item.email,
                      //to: "cleber.znch@gmail.com",
                      bcc: "cleber.znch@gmail.com",
                      subject:
                        "Novo Relatório de despesas para aprovação",
                      text: "Novo Relatório de despesas para aprovação",
                      template: "apprdespesa",
                      context: {
                        numero: DespesaDoc.numero,
                        requester: DespesaDoc.nomerequester,
                        data: DespesaDoc.updatedAt,
                        obsgeral: DespesaDoc.obsgeral,
                        titulo: "Novo Relatório de despesas para aprovação",
                        status: "Pendente Aprovação",
                        support_email: "mailto:app@superfriosr.com.br",
                      },
                    });
                 } catch (err) {
                    console.log(err);
                 } 
        
                  if (item.pushToken) {
                    messages.push({
                      to: item.pushToken,
                      sound: "default",
                      priority: "high",
                      wake_screen: true,
                      show_in_foreground: true,
                      title: "Novo Relatório de despesas para aprovação",
                      body:
                        "Novo relatório de despesas aguardando sua aprovação. Revise pelo App Superfrio.",
                    });
                  }
                }
              }
        }

        if (status == "2") { //aprova -- Incluir email final para o financeiro
          await DespesaItem.updateMany(
            { iddespesa: req.params.id, status: { $ne: "3" } },
            { status: "2" }
          );
          const user = await Usuario.find({ _id: DespesaDoc.idrequester });
          if (user) {
            let transporter = nodemailer.createTransport({
              host: process.env.EMAIL_SMTP,
              port: 465,
              auth: {
                user: process.env.EMAIL_ACC,
                pass: process.env.EMAIL_PWD,
              },
            });
    
            const options = {
              viewEngine: {
                extName: ".handlebars",
                partialsDir: "./views/",
                defaultLayout: false,
              },
              viewPath: "./views/",
              extName: ".handlebars",
            };
    
            transporter.use("compile", hbs(options));
    
            for (const item of user) {
    
              try {
                await transporter.sendMail({
                  from: "App Superfrio <app@superfriosr.com.br>",
                  to: item.email,
                  //to: "cleber.znch@gmail.com",
                  bcc: "cleber.znch@gmail.com",
                  subject:
                    "Seu Relatório de despesas foi aprovado",
                  text: "Seu Relatório de despesas foi aprovado",
                  template: "apprdespesaAprovado",
                  context: {
                    numero: DespesaDoc.numero,
                    requester: DespesaDoc.nomerequester,
                    aprovador: DespesaDoc.nomeaprovador,
                    obsgeral: DespesaDoc.obsgeral,
                    //data: DespesaDoc.updatedAt,
                    titulo: "Seu Relatório de despesas foi aprovado",
                    status: "Aprovado",
                    support_email: "mailto:app@superfriosr.com.br",
                  },
                });
             } catch (err) {
                console.log(err);
             } 
    
              if (item.pushToken) {
                messages.push({
                  to: item.pushToken,
                  sound: "default",
                  priority: "high",
                  wake_screen: true,
                  show_in_foreground: true,
                  title: "Seu Relatório de despesas foi aprovado",
                  body:
                    "Seu Relatório de despesas foi aprovado. Revise pelo App Superfrio.",
                });
              }
            }
            
            sendFinalEmail(DespesaDoc, messages, transporter);

          }
        }

        if (status == "3") { //rejeita
          await DespesaItem.updateMany(
            { iddespesa: req.params.id },
            { status: "3" }
          );
          const user = await Usuario.find({ _id: DespesaDoc.idrequester });
          if (user) {
            let transporter = nodemailer.createTransport({
              host: process.env.EMAIL_SMTP,
              port: 465,
              auth: {
                user: process.env.EMAIL_ACC,
                pass: process.env.EMAIL_PWD,
              },
            });
    
            const options = {
              viewEngine: {
                extName: ".handlebars",
                partialsDir: "./views/",
                defaultLayout: false,
              },
              viewPath: "./views/",
              extName: ".handlebars",
            };
    
            transporter.use("compile", hbs(options));
    
            for (const item of user) {
    
              try {
                await transporter.sendMail({
                  from: "App Superfrio <app@superfriosr.com.br>",
                  to: item.email,
                  //to: "cleber.znch@gmail.com",
                  bcc: "cleber.znch@gmail.com",
                  subject:
                    "Seu Relatório de despesas foi reprovado",
                  text: "Seu Relatório de despesas foi reprovado",
                  template: "apprdespesa",
                  context: {
                    numero: DespesaDoc.numero,
                    requester: DespesaDoc.nomerequester,
                    data: DespesaDoc.updatedAt,
                    obsgeral: DespesaDoc.obsgeral,
                    titulo: "Seu Relatório de despesas foi reprovado",
                    status: "Reprovado",
                    support_email: "mailto:app@superfriosr.com.br",
                  },
                });
             } catch (err) {
                console.log(err);
             } 
    
              if (item.pushToken) {
                messages.push({
                  to: item.pushToken,
                  sound: "default",
                  priority: "high",
                  wake_screen: true,
                  show_in_foreground: true,
                  title: "Seu Relatório de despesas foi reprovado",
                  body:
                    "Seu Relatório de despesas foi reprovado. Revise pelo App Superfrio.",
                });
              }
            }
          }
        }

        return res.json(returnUpdate)
    },

    async markSelectedAsPaid(req, res) {
      const selectedItems = Array.isArray(req.body?.selectedItems) ? req.body.selectedItems : [];

      const ids = selectedItems
        .map((id) => String(id))
        .filter((id) => /^[a-fA-F0-9]{24}$/.test(id));

      if (ids.length === 0) {
        return res.status(400).json({ error: "Nenhum relatório válido selecionado" });
      }

      const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();

      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({ error: "Data de pagamento inválida" });
      }

      const returnUpdate = await Despesa.updateMany(
        { _id: { $in: ids } },
        { paid: true, paidAt }
      );

      return res.json({
        success: true,
        paidAt,
        matchedCount: returnUpdate.matchedCount ?? returnUpdate.n,
        modifiedCount: returnUpdate.modifiedCount ?? returnUpdate.nModified
      });
    },

    async deleteSelected(req, res) {
      const selectedItems = Array.isArray(req.body?.selectedItems) ? req.body.selectedItems : [];

      const ids = selectedItems
        .map((id) => String(id))
        .filter((id) => /^[a-fA-F0-9]{24}$/.test(id));

      const uniqueIds = Array.from(new Set(ids));

      if (uniqueIds.length === 0) {
        return res.status(400).json({ error: "Nenhuma despesa válida selecionada" });
      }

      if (selectedItems.length !== uniqueIds.length) {
        return res.status(400).json({ error: "A seleção contém IDs duplicados ou inválidos" });
      }

      if (uniqueIds.length > MAX_BULK_DELETE_COUNT) {
        return res.status(422).json({
          error: `Por segurança, é permitido remover no máximo ${MAX_BULK_DELETE_COUNT} despesas por vez`,
          maxBulkDeleteCount: MAX_BULK_DELETE_COUNT
        });
      }

      const expectedCount = Number(req.body?.expectedCount);
      if (!Number.isInteger(expectedCount) || expectedCount !== uniqueIds.length) {
        return res.status(400).json({ error: "A quantidade confirmada não confere com a seleção enviada" });
      }

      const confirmationText = String(req.body?.confirmationText || "").trim().toUpperCase();
      const expectedConfirmationText = buildBulkDeleteConfirmationText(uniqueIds.length);
      if (confirmationText !== expectedConfirmationText) {
        return res.status(400).json({
          error: `Confirmação inválida. Digite exatamente: ${expectedConfirmationText}`,
          expectedConfirmationText
        });
      }

      const despesas = await Despesa.find({ _id: { $in: uniqueIds } }).lean();
      const despesasById = despesas.reduce((acc, item) => {
        acc[String(item._id)] = item;
        return acc;
      }, {});

      const notFoundItems = uniqueIds
        .filter((id) => !despesasById[id])
        .map((id) => ({
          id,
          numero: "",
          status: "",
          reason: "Despesa não encontrada"
        }));

      const deletable = [];
      const blockedItems = [...notFoundItems];

      uniqueIds.forEach((id) => {
        const despesa = despesasById[id];
        if (!despesa) {
          return;
        }

        if (!DELETABLE_DESPESA_STATUS.includes(String(despesa.status))) {
          blockedItems.push({
            id,
            numero: despesa.numero,
            status: String(despesa.status),
            reason: getInvalidDeleteReason(despesa)
          });
          return;
        }

        deletable.push(despesa);
      });

      if (blockedItems.length > 0) {
        return res.status(409).json({
          success: false,
          error: "A seleção contém despesas que não podem ser removidas. Nenhum registro foi apagado.",
          deletedIds: [],
          deletedCount: 0,
          deletedItemsCount: 0,
          blockedItems,
          blockedCount: blockedItems.length
        });
      }

      const deletedResults = await deleteDespesasBatch(deletable);

      return res.json({
        success: true,
        deletedIds: deletedResults.deletedIds,
        deletedCount: deletedResults.deletedCount,
        deletedItemsCount: deletedResults.deletedItemsCount,
        blockedItems: [],
        blockedCount: 0
      });
    },

    async delete(req, res){
        const despesa = await Despesa.findById(req.params.id).lean();

        if (!despesa) {
          return res.status(404).json({ error: "Despesa não encontrada" });
        }

        if (!DELETABLE_DESPESA_STATUS.includes(String(despesa.status))) {
          return res.status(409).json({
            error: "Só é permitido remover despesas em Rascunho ou Aguardando Aprovação.",
            status: String(despesa.status),
            statusLabel: getDespesaStatusLabel(despesa.status)
          });
        }

        const result = await deleteDespesaCascade(despesa);
        return res.json({
          success: true,
          deletedDespesaId: result.deletedDespesaId,
          deletedItemsCount: result.deletedItemsCount
        });
    },

    async store(req, res) {
        const { dataentrada, status, pdflink, idrequester, nomerequester, idaprovador, nomeaprovador, commaprovador, obsgeral } = req.body;
        var numeroDoc;
        // buscar pelo ultimo numero e inserir numero+1 para o store
        try {
            const returnNumero = await Despesa.findOne({}).sort({numero: -1}).collation({locale: "en_US", numericOrdering: true});    
            numeroDoc = parseInt(returnNumero.numero) + 1;
        } catch (error) {
            numeroDoc = 1;
        }
        
        const returnPost = await Despesa.create(
            {
                dataentrada, 
                numero: numeroDoc,
                status, 
                pdflink, 
                idrequester, 
                nomerequester, 
                idaprovador, 
                nomeaprovador, 
                commaprovador, 
                obsgeral    
            },
            async function (erro, docDespesa) {
            //     docDespesaId = docDespesa._id;
            //     await itens.forEach(async function (item) {
            //         await DespesaItem.create({
            //             descr:item.descr, 
            //             foto:item.foto, 
            //             categoria:item.categoria, 
            //             valor:item.valor, 
            //             iddespesa: docDespesa._id
            //         })
            //     });
            console.log(erro);
                return await res.json({docDespesaId:docDespesa._id})
            }
        );
        
    }

};

async function sendFinalEmail(DespesaDoc, messages, transporter){
  //envia email para financeiro

  // buscar usuarios com flag receive_final_email ativo
  let userFinal = await Usuario.find({ receive_final_despesa: true });

  //faz a soma dos valores dos items
  let DespesaItemValor = await DespesaItem.aggregate([
      { 
        $match:
        {
          "iddespesa": DespesaDoc._id
        }
      },
      {
        $group:
          {
            _id: null,
            totalAmount: { $sum: "$valor"}
          }
      }
  ]);

  for (const item of userFinal) {
    try {
      await transporter.sendMail({
        from: "App Superfrio <app@superfriosr.com.br>",
        to: item.email,
        //to: "cleber.znch@gmail.com",
        bcc: "cleber.znch@gmail.com",
        subject:
          "Novo Relatório de despesas aprovado",
        text: "Novo Relatório de despesas aprovado",
        template: "apprdespesaFinal",
        context: {
          numero: DespesaDoc.numero,
          requester: DespesaDoc.nomerequester,
          //data: DespesaDoc.updatedAt,
          aprovador: DespesaDoc.nomeaprovador,
          obsgeral: DespesaDoc.obsgeral,
          valor: DespesaItemValor[0]?.totalAmount || 0,
          titulo: "Novo Relatório de despesas aprovado",
          status: "Aprovado",
          support_email: "mailto:app@superfriosr.com.br",
        },
      });
    } catch (err) {
        console.log(err);
    } 

    if (item.pushToken) {
      messages.push({
        to: item.pushToken,
        sound: "default",
        priority: "high",
        wake_screen: true,
        show_in_foreground: true,
        title: "Novo Relatório de despesas aprovado",
        body:
          "Novo relatório de despesas aprovado. Por favor analisar e seguir com a programação",
      });
    }

  }
};
