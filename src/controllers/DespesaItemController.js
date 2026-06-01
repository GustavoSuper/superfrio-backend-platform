const DespesaItem = require('../model/DespesaItem');
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

        const returnUpdate = await DespesaItem.updateOne({ _id: req.params.id }, updateBody);
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
