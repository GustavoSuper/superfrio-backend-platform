const { Schema, model} = require('mongoose');

const UsuarioSchema = new Schema({
    nome: {
        type: String
    },
    email: {
        type: String,
        required: true
    },
    pwd: {
        type: String,
        required: true
    },
    validado: {
        type: Boolean,
        required: true
    },
    admin: {
        type: Boolean,
        required: true
    },
    access_web: {
        type: Boolean,
        required: true
    },
    web_appr:{
        type: Boolean,
        required: true
    },
    desp_appr:{
        type: Boolean,
        required: true,
        default: false
    },
    access_app: {
        type: Boolean,
        required: true
    },
    access_comp:{
        type: Boolean,
        required: true
    },
    access_pit:{
        type: Boolean,
        required: true
    },
    access_rack:{
        type: Boolean,
        required: true,
        default: false
    },
    access_despesa:{
        type: Boolean,
        required: true,
        default: false
    },
    telefone: {
        type: String
    },
    centro_custo: {
        type: String
    },
    area: {
        type: String,
        required: true
    },
    idarea: {
        type: String,
        required: true
    },
    receive_final_despesa:{
        type: Boolean,
        required: true,
        default: false
    },
    pushToken: {
        type: String
    },
    dados_bancarios: {
        // 'pix' ou 'conta'
        tipo: { type: String, enum: ['', 'pix', 'conta'], default: '' },
        // Pix
        pix_tipo_chave: { type: String, default: '' },
        pix_chave: { type: String, default: '' },
        // Conta bancária
        banco: { type: String, default: '' },
        tipo_conta: { type: String, default: '' },
        agencia: { type: String, default: '' },
        conta: { type: String, default: '' },
        conta_digito: { type: String, default: '' },
        // Titular
        titular_nome: { type: String, default: '' },
        titular_tipo_doc: { type: String, enum: ['', 'CPF', 'CNPJ'], default: '' },
        titular_documento: { type: String, default: '' },
    },
}, {
    timestamps: true
});

module.exports = model('Usuario', UsuarioSchema);