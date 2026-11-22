// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (kit ISA.md).
// One run answers every program in /input/<id>/: writes /output/<id>/stdout.bin + exit.txt.
// Node 22, built-ins only, deterministic: no clock, no environment reads.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Runs one program on its input bytes; returns [output bytes, exit code].
function run(p: Buffer, inp: Buffer): [Buffer, number] {
  const n = p.length;
  const S = new Int32Array(256); // data stack
  let sp = 0;
  const C = new Int32Array(64); // call stack
  let cp = 0;
  const M = new Int32Array(256); // memory words
  const out = new Uint8Array(65536);
  const dig = new Uint8Array(11); // scratch for PRINT's decimal digits
  let ol = 0, ip = 0, pc = 0, st = 0;
  const done = (c: number): [Buffer, number] => [Buffer.from(out.subarray(0, ol)), c];

  for (;;) {
    if (st === 1000000) return done(10); // step limit, checked first
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const op = p[pc];
    // Immediate length; bytes no opcode names are rejected (trap 5).
    let im = 0;
    if (op === 1) im = 1;
    else if (op === 2) im = 4;
    else if (op >= 48 && op <= 51) im = 2;
    else if (!((op <= 7) || (op >= 16 && op <= 30) || (op >= 32 && op <= 34) ||
      (op >= 48 && op <= 52) || (op >= 64 && op <= 65) || (op >= 80 && op <= 83))) return done(5);
    if (pc + im >= n) return done(9); // immediate cut off by the program's end
    st++;
    const nx = pc + 1 + im;
    pc = nx;
    switch (op) {
      case 0: return done(0); // HALT
      case 1: // PUSH8: one byte, sign-extended
        if (sp >= 256) return done(3);
        S[sp++] = (p[nx - 1] << 24) >> 24;
        break;
      case 2: // PUSH32: four bytes, little-endian, signed
        if (sp >= 256) return done(3);
        S[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 3: // POP
        if (sp < 1) return done(2);
        sp--;
        break;
      case 4: // DUP
        if (sp < 1) return done(2);
        if (sp >= 256) return done(3);
        S[sp] = S[sp - 1]; sp++;
        break;
      case 5: { // SWAP
        if (sp < 2) return done(2);
        const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t;
        break;
      }
      case 6: // OVER
        if (sp < 2) return done(2);
        if (sp >= 256) return done(3);
        S[sp] = S[sp - 2]; sp++;
        break;
      case 7: { // ROT: (a b c -- b c a)
        if (sp < 3) return done(2);
        const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a;
        break;
      }
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: { // two-operand arithmetic / logic / compare
        if (sp < 2) return done(2);
        const b = S[sp - 1], a = S[sp - 2];
        let r: number;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) {
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 20) {
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 21) {
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 22) {
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = a << (b & 31);
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; S[sp++] = r;
        break;
      }
      case 23: // NEG
        if (sp < 1) return done(2);
        S[sp - 1] = -S[sp - 1] | 0;
        break;
      case 27: // NOT
        if (sp < 1) return done(2);
        S[sp - 1] = ~S[sp - 1];
        break;
      case 48: case 49: case 50: { // JMP / JZ / JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 48) {
          if (sp < 1) return done(2);
          const v = S[--sp];
          take = op === 49 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 51: // CALL: unsigned 16-bit target
        if (cp >= 64) return done(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 52: // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 64: { // LOAD
        if (sp < 1) return done(2);
        const ad = S[sp - 1];
        if (ad < 0 || ad >= 256) return done(6);
        S[sp - 1] = M[ad];
        break;
      }
      case 65: { // STORE: (value address --), address on top
        if (sp < 2) return done(2);
        const ad = S[sp - 1], v = S[sp - 2];
        if (ad < 0 || ad >= 256) return done(6);
        sp -= 2; M[ad] = v;
        break;
      }
      case 80: { // PRINT: decimal text, no newline; digits written by hand
        if (sp < 1) return done(2);
        let v = S[sp - 1];
        let neg = false;
        if (v < 0) { neg = true; v = -v; }
        let d = 0;
        do { dig[d++] = 48 + (v % 10); v = Math.floor(v / 10); } while (v > 0);
        if (ol + d + (neg ? 1 : 0) > 65536) return done(11);
        sp--;
        if (neg) out[ol++] = 45;
        while (d > 0) out[ol++] = dig[--d];
        break;
      }
      case 81: // PUTC: one byte, low 8 bits
        if (sp < 1) return done(2);
        if (ol + 1 > 65536) return done(11);
        out[ol++] = S[--sp] & 255;
        break;
      case 82: // IN: next input byte, -1 when exhausted
        if (sp >= 256) return done(3);
        S[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 83: // EXIT: code is the low byte
        if (sp < 1) return done(2);
        return done(S[--sp] & 255);
      default:
        return done(5);
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const p = readFileSync(join(IN, id, 'program.bin'));
  const inp = readFileSync(join(IN, id, 'input.bin'));
  const [out, code] = run(p, inp);
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), out);
  writeFileSync(join(OUT, id, 'exit.txt'), String(code) + '\n');
}
