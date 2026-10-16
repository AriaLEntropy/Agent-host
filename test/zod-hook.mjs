const zodUrl = new URL("../node_modules/zod/index.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "zod") return { url: zodUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
