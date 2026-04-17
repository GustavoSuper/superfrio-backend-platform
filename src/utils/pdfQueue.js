// src/utils/pdfQueue.js
let pdfQueue = Promise.resolve();

function runPdfJob(job) {
    const nextJob = pdfQueue.then(() => job());
    pdfQueue = nextJob.catch(() => {});
    return nextJob;
}

module.exports = { runPdfJob };