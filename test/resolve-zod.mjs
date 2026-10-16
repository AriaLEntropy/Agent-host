import { register } from "node:module";

register(new URL("./zod-hook.mjs", import.meta.url), import.meta.url);
