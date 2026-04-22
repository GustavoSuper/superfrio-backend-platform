// src/utils/pdfQueue.js
const axios = require('axios');

let sharp = null;
try {
    sharp = require('sharp');
} catch (err) {
    sharp = null;
}

let pdfQueue = Promise.resolve();

function runPdfJob(job) {
    const nextJob = pdfQueue.then(() => job());
    pdfQueue = nextJob.catch(() => {});
    return nextJob;
}

async function enablePdfImageOptimization(page, options = {}) {
    if (!sharp) return;

    const quality = Number.isFinite(options.quality) ? options.quality : 70;
    const maxDimension = Number.isFinite(options.maxDimension) ? options.maxDimension : 1280;
    const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : 150 * 1024;

    await page.setRequestInterception(true);

    page.on('request', async (request) => {
        try {
            if (request.resourceType() !== 'image') {
                return request.continue();
            }

            const url = request.url();
            if (url.startsWith('data:')) {
                return request.continue();
            }

            const resp = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 300
            });

            const contentType = (resp.headers && resp.headers['content-type']) ? resp.headers['content-type'] : 'application/octet-stream';
            const input = Buffer.from(resp.data);

            if (input.length < minBytes) {
                return request.respond({
                    status: 200,
                    contentType,
                    body: input
                });
            }

            const image = sharp(input, { failOnError: false, animated: false });
            const meta = await image.metadata();

            if (!meta || meta.format === 'svg') {
                return request.respond({
                    status: 200,
                    contentType,
                    body: input
                });
            }

            let pipeline = image;

            if (meta.width && meta.height) {
                pipeline = pipeline.resize({
                    width: maxDimension,
                    height: maxDimension,
                    fit: 'inside',
                    withoutEnlargement: true
                });
            }

            if (meta.hasAlpha) {
                const out = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer();
                return request.respond({
                    status: 200,
                    contentType: 'image/png',
                    body: out
                });
            }

            const out = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
            return request.respond({
                status: 200,
                contentType: 'image/jpeg',
                body: out
            });

        } catch (err) {
            try {
                return request.continue();
            } catch (continueErr) {
                return;
            }
        }
    });
}

module.exports = { runPdfJob, enablePdfImageOptimization };