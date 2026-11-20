import { spawn } from "node:child_process";
import type { Manuscript } from "../shared/manuscript.js";
import { PATHS } from "./config.js";

export function readManuscript(docx: Buffer): Promise<Manuscript> {
  return new Promise((resolve, reject) => {
    const child = spawn(PATHS.manuscriptPython, [PATHS.manuscriptReader], {
      windowsHide: true,
      timeout: 15_000,
    });
    const output: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else output.push(part);
    });
    child.stdin.on("error", () => { /* An early exit is reported below. */ });
    child.on("error", () => reject(new Error("Unable to start the project Python environment.")));
    child.stderr.resume();
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("Could not read the Word document. Choose a valid .docx with a text body."));
      try {
        resolve(JSON.parse(Buffer.concat(output).toString("utf8")) as Manuscript);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(docx);
  });
}
