if (!Map.prototype.getOrInsertComputed) {
  // eslint-disable-next-line no-extend-native -- PDF.js 5 expects this stage-3 Map API in newer Chromium.
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    configurable: true,
    value(key, callback) {
      if (this.has(key)) {
        return this.get(key);
      }
      const value = callback(key);
      this.set(key, value);
      return value;
    },
    writable: true,
  });
}

if (!Math.sumPrecise) {
  Object.defineProperty(Math, "sumPrecise", {
    configurable: true,
    value(values) {
      let sum = 0;
      let compensation = 0;
      for (const value of values) {
        const next = value - compensation;
        const total = sum + next;
        compensation = total - sum - next;
        sum = total;
      }
      return sum;
    },
    writable: true,
  });
}

await import("pdfjs-dist/build/pdf.worker.mjs");
