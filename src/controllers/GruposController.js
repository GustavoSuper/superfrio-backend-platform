const Grupos = require('../model/Grupos.js');
const ChecklistItemDefault = require('../model/ChecklistItemDefault');

module.exports = {

    async index(req, res){
        const returnGet = await Grupos.find();
        return res.json(returnGet)
    },

    async show(req, res){ //Retorna os itensrack que estão dentro do grupo
        try {
            const grupo = await Grupos.findById(req.params.id);
            if(!grupo){ return res.status(404).json({sucess: false, msg: "Grupo não encotrado"})}

            const RackItens = await ChecklistItemDefault.find({ type:'rack' }).sort({ordemitem: 1});
            const itensFiltrados = await RackItens.filter(objeto => grupo.itensRack.includes(objeto._id));

            const returnGet = {
                nome: grupo.nome,
                itensDoGrupo: itensFiltrados
            }

            return res.json(returnGet)
        } catch (error) {
            res.status(404).json({sucess: false, msg: "Erro"})
        }
    },

    async store(req, res) {
        try {
            const {nome, itensRack} = req.body;

            if(!nome){
                return res.status(400).json({msg: "Informe o nome do grupo"})
            }
    
            const verifyUniqueName = await Grupos.findOne({nome: nome});
            if(verifyUniqueName){
                return res.status(400).json({msg: "Um grupo com esse nome já existe"})
            }
    
           await Grupos.create({
                nome,
                itensRack
            });
    
            return res.status(201).json({sucess: true, msg: `Grupo ${nome} criado com sucesso`});
        } catch (error) {
            res.status(400).json({sucess: false, msg: `Falha ao tentar criar grupo`});
        }
    },

    async addNewItemsToGroup(req, res){
        try {
    
            const {newItems} = req.body
            if(!newItems){ return res.status(400).json({sucess: false, msg: "nenhum item para ser adicionado"})}

            const resultado = await Grupos.findByIdAndUpdate(
                req.params.id,
                {
                  $addToSet: {
                    itensRack: { $each: newItems }
                  }
                },
                { new: true } // retorna o documento atualizado
              );
              
              res.status(200).json(resultado);

        } catch (error) {
            res.status(400).json({sucess: false, msg: `Falha ao tentar adicionar itens ao grupo`});
        }
    },

    async removeItemsOfGroup(req, res){
        try {
    
            const {itemsToRemove} = req.body
            if(!itemsToRemove){ return res.status(400).json({sucess: false, msg: "nenhum item para ser removido"})}

            const resultado = await Grupos.findByIdAndUpdate(
                req.params.id,
                {
                  $pull: {
                    itensRack: { $in: itemsToRemove }
                  }
                },
                { new: true } // retorna o documento atualizado
              );
              
              res.status(200).json(resultado);

        } catch (error) {
            res.status(400).json({sucess: false, msg: `Falha ao tentar remover itens ao grupo`});
        }
    },

    async delete(req, res){
        try {
            await Grupos.deleteOne({ _id: req.params.id });
            return res.status(200).json({sucess: true, msg: "Grupo deletado com sucesso"})
        } catch (error) {
            res.status(400).json({sucess: false, msg: `Falha ao deletar grupo`});
        }
    }
};