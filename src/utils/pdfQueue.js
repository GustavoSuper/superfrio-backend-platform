let pdfQueue = Promise.resolve();
const pdfCooldowns = new Map();

function runPdfJob(job) {
    const nextJob = pdfQueue.then(() => job());
    pdfQueue = nextJob.catch(() => {});
    return nextJob;
}

function acquirePdfCooldown(key, cooldownMs) {
    const now = Date.now();
    const expiresAt = pdfCooldowns.get(key);

    if (expiresAt && expiresAt > now) {
        return { ok: false, retryAfterMs: expiresAt - now };
    }

    if (expiresAt && expiresAt <= now) {
        pdfCooldowns.delete(key);
    }

    pdfCooldowns.set(key, now + cooldownMs);
    return { ok: true, retryAfterMs: 0 };
}

module.exports = { runPdfJob, acquirePdfCooldown };