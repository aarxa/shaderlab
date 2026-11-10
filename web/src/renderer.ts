// WebGL2 renderer for Shadertoy-style fragment shaders: the user writes mainImage(), we wrap it
// in a full-screen-triangle program and feed iResolution / iTime / iMouse every frame.

export interface CompileError {
  line: number; // 1-based line in the user's code
  message: string;
}

const HEADER = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec4 iMouse;
out vec4 shaderlab_outColor;
`;
const HEADER_LINES = HEADER.split('\n').length - 1;
const FOOTER = `
void main() { mainImage(shaderlab_outColor, gl_FragCoord.xy); }
`;
const VERTEX = `#version 300 es
void main() {
  // One triangle that covers the whole screen; no vertex buffer needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Parses driver logs like "ERROR: 0:12: 'foo' : undeclared identifier" into user-code lines. */
export function parseErrors(log: string): CompileError[] {
  const out: CompileError[] = [];
  // Drivers pad the log with NUL and other control characters; strip them before parsing.
  for (const raw of log.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').split('\n')) {
    const m = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(raw.trim());
    if (m) out.push({ line: Math.max(1, Number(m[1]) - HEADER_LINES), message: m[2] });
    else if (raw.trim()) out.push({ line: 1, message: raw.trim() });
  }
  return out;
}

export class ShaderRenderer {
  private gl: WebGL2RenderingContext;
  private vs: WebGLShader;
  private program: WebGLProgram | null = null;
  private uniforms: { res: WebGLUniformLocation | null; time: WebGLUniformLocation | null; mouse: WebGLUniformLocation | null } | null = null;
  private start = performance.now();
  private mouse = [0, 0, 0, 0];
  private raf = 0;
  frameMs = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.vs = this.compile(gl.VERTEX_SHADER, VERTEX).shader!;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const s = canvas.width / r.width;
      if (e.buttons) this.mouse = [(e.clientX - r.left) * s, (r.bottom - e.clientY) * s, this.mouse[2], this.mouse[3]];
    });
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const s = canvas.width / r.width;
      const x = (e.clientX - r.left) * s, y = (r.bottom - e.clientY) * s;
      this.mouse = [x, y, x, y];
    });
  }

  private compile(type: number, src: string): { shader: WebGLShader | null; log: string } {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? 'compile failed';
      gl.deleteShader(sh);
      return { shader: null, log };
    }
    return { shader: sh, log: '' };
  }

  /** Compiles new user code. On failure the previous working program keeps running. */
  setCode(code: string): CompileError[] {
    const gl = this.gl;
    const { shader: fs, log } = this.compile(gl.FRAGMENT_SHADER, HEADER + code + FOOTER);
    if (!fs) return parseErrors(log);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const linkLog = gl.getProgramInfoLog(prog) ?? 'link failed';
      gl.deleteProgram(prog);
      return parseErrors(linkLog);
    }
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.uniforms = {
      res: gl.getUniformLocation(prog, 'iResolution'),
      time: gl.getUniformLocation(prog, 'iTime'),
      mouse: gl.getUniformLocation(prog, 'iMouse'),
    };
    return [];
  }

  startLoop() {
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      this.draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  private draw() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (!this.program || !this.uniforms) return;
    const t0 = performance.now();
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.uniform3f(this.uniforms.res, w, h, 1);
    gl.uniform1f(this.uniforms.time, (t0 - this.start) / 1000);
    gl.uniform4f(this.uniforms.mouse, this.mouse[0], this.mouse[1], this.mouse[2], this.mouse[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  /**
   * Draws one frame right now and returns it as a small image (center-cropped to w×h), or null if
   * nothing has compiled yet. The canvas uses preserveDrawingBuffer: false (faster), which means
   * its pixels are only readable until the frame is shown, so we draw and copy in the same task
   * instead of reading whatever the last animation frame left behind.
   */
  async capture(w = 320, h = 180): Promise<Blob | null> {
    if (!this.program) return null;
    this.draw();
    const sw = this.canvas.width, sh = this.canvas.height;
    if (!sw || !sh) return null;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const scale = Math.max(w / sw, h / sh); // "cover": fill the thumbnail, crop the overflow
    const cw = w / scale, ch = h / scale;
    ctx.drawImage(this.canvas, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
    const toBlob = (type: string, q: number) => new Promise<Blob | null>((r) => out.toBlob(r, type, q));
    // WebP is ~30% smaller than JPEG here. Browsers that can't encode WebP (Safari) silently return
    // a PNG instead, which is much larger for noisy shader output, so fall back to JPEG.
    const webp = await toBlob('image/webp', 0.8);
    return webp?.type === 'image/webp' ? webp : toBlob('image/jpeg', 0.85);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.program) this.gl.deleteProgram(this.program);
    this.gl.deleteShader(this.vs);
  }
}
