const DespesaItem = require('../model/DespesaItem');
const Despesa = require('../model/Despesa');
const Usuario = require('../model/Usuario');
const mongoose = require('mongoose');

async function addRequesterArea(items) {
    const requesterIds = items
        .map((item) => Array.isArray(item.iddespesa) ? item.iddespesa[0] : item.iddespesa)
        .map((despesa) => despesa && despesa.idrequester)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id));

    const users = await Usuario.find({ _id: { $in: requesterIds } }).select("_id area").lean();
    const usersById = users.reduce((acc, user) => {
        acc[String(user._id)] = user;
        return acc;
    }, {});

    return items.map((item) => {
        if (Array.isArray(item.iddespesa)) {
            const despesas = item.iddespesa.map((despesa) => ({
                ...despesa,
                requesterArea: usersById[String(despesa.idrequester)]?.area || ""
            }));
            return {
                ...item,
                iddespesa: despesas,
                requesterArea: despesas[0]?.requesterArea || ""
            };
        }

        const requesterArea = usersById[String(item.iddespesa?.idrequester)]?.area || "";
        return {
            ...item,
            iddespesa: item.iddespesa ? { ...item.iddespesa, requesterArea } : item.iddespesa,
            requesterArea
        };
    });
}

function normalizeStatus(status) {
    return typeof status === "undefined" || status === null ? "" : String(status);
}

async function syncDespesaStatusFromItems(iddespesa) {
    if (!iddespesa) {
        return;
    }

    const [despesa, itens] = await Promise.all([
        Despesa.findById(iddespesa),
        DespesaItem.find({ iddespesa }).select("status").lean()
    ]);

    if (!despesa || itens.length === 0) {
        return;
    }

    const normalizedStatuses = itens.map((item) => normalizeStatus(item.status));
    const hasPendingItems = normalizedStatuses.some((status) => !["2", "3"].includes(status));
    const hasApprovedItems = normalizedStatuses.some((status) => status === "2");
    const allRejectedItems = normalizedStatuses.every((status) => status === "3");

    let nextDespesaStatus = normalizeStatus(despesa.status);

    if (!hasPendingItems) {
        nextDespesaStatus = allRejectedItems && !hasApprovedItems ? "3" : "2";
    } else if (["2", "3"].includes(normalizeStatus(despesa.status))) {
        nextDespesaStatus = "1";
    }

    const updateBody = {};
    if (nextDespesaStatus !== normalizeStatus(despesa.status)) {
        updateBody.status = nextDespesaStatus;
    }

    if (nextDespesaStatus === "2" && !despesa.approvedAt) {
        updateBody.approvedAt = new Date();
    }

    if (nextDespesaStatus !== "2" && despesa.approvedAt) {
        updateBody.approvedAt = null;
    }

    if (Object.keys(updateBody).length > 0) {
        await Despesa.updateOne({ _id: despesa._id }, updateBody);
    }
}


module.exports = {

    async index(req, res){

        const returnGet = await DespesaItem.find();
        return res.json(returnGet)
    },

    async aggreg(req, res){
        const returnGet = await DespesaItem.aggregate([
          { $sort: { createdAt: -1 } },
          {
              $project: {
                categoriaText: 1,
                iddespesa: 1,
                valor: 1,
                descr: 1,
                foto: 1
              },
          },
          {
              $lookup: {
                from: "despesas",
                localField: "iddespesa",
                foreignField: "_id",
                as: "iddespesa",
              },
            }
        ]);
    
        return res.json(await addRequesterArea(returnGet));
      },

    async seletedAggreg(req, res){

        const { selectedItems } = req.body;

        if(!selectedItems){
            return res.status(400).json({msg: "Nenhum item selecionado"})
        }

        const ids = selectedItems
            .map((id) => String(id))
            .filter((id) => mongoose.Types.ObjectId.isValid(id));

        if (ids.length === 0) {
            return res.status(400).json({ msg: "Nenhum item válido selecionado" });
        }

        const returnGet = await DespesaItem.aggregate([
            { $sort: { createdAt: -1 } },
            {
                $project: {
                    categoriaText: 1,
                    iddespesa: 1,
                    valor: 1,
                    descr: 1,
                    foto: 1
                },
            },
            {
                $lookup: {
                    from: "despesas",
                    localField: "iddespesa",
                    foreignField: "_id",
                    as: "iddespesa",
                },
            },
            {
                $unwind: "$iddespesa"
            },
            {
                $match: {
                    "iddespesa._id": { $in: ids.map(id => mongoose.Types.ObjectId(id)) }
                }
            }
        ]);

        return res.json(await addRequesterArea(returnGet));   
      },

    async show(req, res){
        const returnShow = await DespesaItem.find({ _id: req.params.id });
        return res.json(returnShow)
    },

    async showByDespesa(req, res){
        const returnShow = await DespesaItem.find({ iddespesa: req.params.id });
        return res.json(returnShow)
    },

    async update(req, res){
        const allowedFields = [
            "descr",
            "foto",
            "fotoSeq",
            "valor",
            "categoria",
            "categoriaText",
            "status",
            "commaprovadorItem",
            "iddespesa"
        ];
        const updateBody = {};

        allowedFields.forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(req.body, field)) {
                updateBody[field] = req.body[field];
            }
        });

        if (Object.keys(updateBody).length === 0) {
            return res.status(400).json({ error: "Nenhum campo válido para atualizar" });
        }

        const itemBeforeUpdate = await DespesaItem.findById(req.params.id);
        if (!itemBeforeUpdate) {
            return res.status(404).json({ error: "Item da despesa não encontrado" });
        }

        const returnUpdate = await DespesaItem.updateOne({ _id: req.params.id }, updateBody);

        if (Object.prototype.hasOwnProperty.call(updateBody, "status")) {
            await syncDespesaStatusFromItems(updateBody.iddespesa || itemBeforeUpdate.iddespesa);
        }

        return res.json(returnUpdate)
    },

    async delete(req, res){
        const returnDel = await DespesaItem.deleteOne({ _id: req.params.id });
        return res.json(returnDel)
    },

    store(req, res) {
        const { descr, foto, valor, categoria, categoriaText ,iddespesa } = req.body;

        const returnPost = DespesaItem.create({
            descr, 
            foto, 
            valor, 
            categoria,
            categoriaText,
            iddespesa
        });

        return res.json(returnPost);
    },

};
