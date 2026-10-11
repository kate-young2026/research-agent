// One PDF per child process: isolate crashes, native handles and timeouts.
process.env.KORDOC_OFFLINE = '1';
try {
  const { parse } = await import('kordoc');
  const result = await parse(process.argv[2], { ocr: true, images: false, scriptTags: true });
  process.send({ result }, () => process.exit(0));
} catch (error) {
  process.send({ error: String(error.message) }, () => process.exit(1));
}
