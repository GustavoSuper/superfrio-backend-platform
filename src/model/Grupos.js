const { Schema, model} = require('mongoose');

const GruposSchema = new Schema({
    nome: {
        type: String,
        required: true
    },
    itensRack: {
        type: Array
    }
}, {
    timestamps: true
});

module.exports = model('Grupos', GruposSchema);