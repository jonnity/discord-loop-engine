// 成功ケースだけ明示 import する。未知URLは常に拒否する。
import { readFile } from "node:fs/promises";
globalThis.fetch = async (input, init) => {
 if(String(input)!=="https://cdn.discordapp.com/attachments/456/111/demo.mp4?signature=secret")throw Error("fixture: unknown fetch");
 if(init?.headers)throw Error("fixture: credentials to CDN");
 if(process.env.RECEIPT_FAIL)throw Error("fixture: download failed");
 return new Response(await readFile(process.env.SENT_COPY!));
};
