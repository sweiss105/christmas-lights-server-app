// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FXparticleSystem.cpp and wled00/FXparticleSystem.h. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
// Particle system by DedeHai (Damian Schneider), Copyright (c) 2024 Damian Schneider, Licensed under the EUPL v. 1.2 or later.
//
// ParticleSystem2D and ParticleSystem1D with the same integer arithmetic as the C code. Differences that
// don't change what is drawn:
// - Memory: each effect instance owns its system (see getPS2D/getPS1D, a WeakMap keyed by the segment)
//   instead of placement-new into SEGENV.data. No memory pools, buffer transfer or PSRAM; particle and
//   source counts are computed exactly as WLED does for an ESP32 (MAXPARTICLES_2D 2048, MAXSOURCES_2D 128,
//   SOURCEREDUCTIONFACTOR 4, MAXPARTICLES_1D 2600, MAXSOURCES_1D 64). Allocation never fails here.
// - Structs are stored as structure-of-arrays in typed arrays whose element types match the C field types,
//   so every store truncates like the C assignment does. A C `PSparticle &part` becomes (arrays, index).
// - The extra FX bytes behind PSdataEnd are a zeroed `extra` byte array (plus typed views).
// - gammaCorrectCol is WLED's default (true).

import { hsv2rgb_spectrum, rgb2hsv, gamma8, gamma8inv, type HSV32 } from './color.js';
import { cos16_t, hw_random16, sin16_t } from './math.js';
import { ColorFromPalette, LINEARBLEND, LINEARBLEND_NOWRAP } from './palettes.js';
import { SEGCOLOR, SEGLEN, SEGMENT, SEGPALETTE, strip, type Segment } from './segment.js';

// ---------------------------------------------------------------------------------------------
// Shared constants and helpers (1D and 2D)
// ---------------------------------------------------------------------------------------------

export const PS_P_MAXSPEED = 120;
const gammaCorrectCol = true;

const s8 = (v: number): number => (v << 24) >> 24;
const s16 = (v: number): number => (v << 16) >> 16;

export function limitSpeed(speed: number): number {
  return speed > PS_P_MAXSPEED ? PS_P_MAXSPEED : speed < -PS_P_MAXSPEED ? -PS_P_MAXSPEED : speed;
}

/** calcForce_dv(force, counter&): the counter's new value is left in `fcCounter`. */
let fcCounter = 0;
function calcForce_dv(force: number, counter: number): number {
  force = s8(force);
  fcCounter = counter & 0xff;
  if (force === 0) return 0;
  const force_abs = force < 0 ? -force : force;
  let dv = 0;
  if (force_abs < 16) {
    fcCounter = (fcCounter + force_abs) & 0xff;
    if (fcCounter > 15) {
      fcCounter = (fcCounter - 16) & 0xff;
      dv = force < 0 ? -1 : 1;
    }
  } else dv = Math.trunc(force / 16);
  return dv;
}

/** checkBoundsAndWrap(position&, max, radius, wrap): returns the new position; in-bounds result in `cbInBounds`. */
let cbInBounds = true;
function checkBoundsAndWrap(position: number, max: number, particleradius: number, wrap: boolean): number {
  cbInBounds = true;
  if ((position >>> 0) > (max >>> 0)) {
    if (wrap) {
      position = position % (max + 1);
      if (position < 0) position += max + 1;
    } else if (position < -particleradius || position > max + particleradius) cbInBounds = false;
  }
  return position;
}

/** fast_color_scaleAdd: c1 + c2*scale/256 (RGB only, white dropped), keeping the colour ratio on overflow. */
export function fast_color_scaleAdd(c1: number, c2: number, scale = 255): number {
  scale &= 0xff;
  let rb = c2 & 0x00ff00ff;
  let g = c2 & 0x0000ff00;
  rb = ((rb * scale) >>> 8) & 0x00ff00ff;
  g = ((g * scale) >>> 8) & 0x0000ff00;
  rb = (c1 & 0x00ff00ff) + rb;
  g = (c1 & 0x0000ff00) + g;
  if ((rb | (g >>> 8)) & 0x01000100) {
    g = g >>> 8;
    let max_val = rb >>> 16;
    max_val = (rb & 0xffff) > max_val ? rb & 0xffff : max_val;
    max_val = g > max_val ? g : max_val;
    const scale_factor = Math.floor((255 << 8) / max_val);
    rb = ((rb * scale_factor) >>> 8) & 0x00ff00ff;
    g = (g * scale_factor) & 0x0000ff00;
  }
  return (rb | g) >>> 0;
}

/** calculateEllipseBrightness (FXparticleSystem.h). */
function calculateEllipseBrightness(dx: number, dy: number, rxsq: number, rysq: number, maxBrightness: number): number {
  const dx_sq = (dx * dx) >>> 0, dy_sq = (dy * dy) >>> 0;
  const dist_sq = Math.floor((dx_sq * 256) / rxsq) + Math.floor((dy_sq * 256) / rysq);
  if (dist_sq >= 256) return 0;
  const falloff = 256 - dist_sq;
  return ((maxBrightness * falloff) >> 8) & 0xff;
}

const hsvTmp: HSV32 = { h: 0, s: 0, v: 0 };

// ---------------------------------------------------------------------------------------------
// 2D particle system
// ---------------------------------------------------------------------------------------------

export const PS_P_RADIUS = 64;
export const PS_P_HALFRADIUS = PS_P_RADIUS >> 1;
export const PS_P_RADIUS_SHIFT = 6;
export const PS_P_SURFACE = 12;
export const PS_P_MINHARDRADIUS = 64;
export const PS_P_MINSURFACEHARDNESS = 128;
const MAXPARTICLES_2D = 2048, MAXSOURCES_2D = 128, SOURCEREDUCTIONFACTOR = 4;
/** handleCollisions with per-particle size: collDistSq for advPartProps[i].size + advPartProps[j].size (0..510). */
const COLLDISTSQ_BY_SIZESUM = Uint32Array.from({ length: 511 }, (_, sum) => {
  const d = (PS_P_MINHARDRADIUS << 1) + ((sum * 52) >>> 6);
  return d * d;
});

/** PSsettings2D bits (LSB first, as in the C bitfield union). */
export const PS2_WRAPX = 1, PS2_WRAPY = 2, PS2_BOUNCEX = 4, PS2_BOUNCEY = 8, PS2_KILL = 16, PS2_GRAVITY = 32, PS2_COLLISIONS = 64, PS2_COLORBYAGE = 128;
/** PSparticleFlags bits. */
export const PF2_OUTOFBOUNDS = 1, PF2_COLLIDE = 2, PF2_PERPETUAL = 4, PF2_CUSTOM1 = 8;

/** An array of PSparticle (+ PSparticleFlags), structure-of-arrays. */
export class Particles2D {
  readonly x: Int16Array; readonly y: Int16Array; readonly ttl: Uint16Array;
  readonly vx: Int8Array; readonly vy: Int8Array; readonly hue: Uint8Array; readonly sat: Uint8Array;
  readonly flags: Uint8Array;
  constructor(readonly length: number) {
    this.x = new Int16Array(length); this.y = new Int16Array(length); this.ttl = new Uint16Array(length);
    this.vx = new Int8Array(length); this.vy = new Int8Array(length); this.hue = new Uint8Array(length); this.sat = new Uint8Array(length);
    this.flags = new Uint8Array(length);
  }
}

export function calculateNumberOfParticles2D(pixels: number, isadvanced: boolean, sizecontrol: boolean): number {
  let n = Math.max(4, Math.min(pixels, MAXPARTICLES_2D));
  if (isadvanced) n = Math.floor((n * 10) / (10 + 2)); // sizeof(PSparticle) = 10, sizeof(PSadvancedParticle) = 2
  if (sizecontrol) n = Math.floor(n / 8);
  return (n + 3) & ~3;
}
export function calculateNumberOfSources2D(pixels: number, requestedsources: number): number {
  let n = Math.min(Math.floor(pixels / SOURCEREDUCTIONFACTOR), requestedsources >>> 0);
  n = Math.max(1, Math.min(n, MAXSOURCES_2D));
  return (n + 3) & ~3;
}

export class ParticleSystem2D {
  readonly particles: Particles2D;
  /** sources[i].source and sources[i].sourceFlags */
  readonly src: Particles2D;
  readonly srcMinLife: Uint16Array; readonly srcMaxLife: Uint16Array;
  readonly srcVar: Int8Array; readonly srcVx: Int8Array; readonly srcVy: Int8Array; readonly srcSize: Uint8Array;
  /** advPartProps (null when not advanced): size, forcecounter */
  readonly advSize: Uint8Array | null = null;
  readonly advForce: Uint8Array | null = null;
  /** advPartSize (PSsizeControl, null unless sizecontrol) */
  readonly sc: {
    asymmetry: Uint8Array; asymdir: Uint8Array; maxsize: Uint8Array; minsize: Uint8Array;
    sizecounter: Uint8Array; wobblecounter: Uint8Array; growspeed: Uint8Array; shrinkspeed: Uint8Array; wobblespeed: Uint8Array;
    grow: Uint8Array; shrink: Uint8Array; pulsate: Uint8Array; wobble: Uint8Array;
  } | null = null;
  /** Bytes behind PSdataEnd for the FX (zeroed), with uint32 / int8 views. */
  readonly extra: Uint8Array;
  readonly extra32: Uint32Array;
  readonly extraI8: Int8Array;

  maxX = 0; maxY = 0; maxXpixel = 0; maxYpixel = 0;
  readonly numSources: number;
  usedParticles: number;
  perParticleSize: boolean;

  private framebuffer: Uint32Array;
  private seg: Segment;
  settings = 0;
  readonly numParticles: number;
  private emitIndex = 0;
  private collisionHardness = 0;
  private wallHardness = 0;
  private wallRoughness = 0;
  private particleHardRadius = 0;
  private collisionStartIdx = 0;
  private fireIntesity = 0;
  private forcecounter = 0;
  private gforcecounter = 0;
  private gforce = 0;
  private particlesize = 0;
  private motionBlur = 0;
  private smearBlur = 0;
  private binIndices: Uint16Array;
  private binLx: Int32Array;
  private binLy: Int32Array;
  private binSz: Uint16Array;
  private bIn = 0; private bPar = 0;

  constructor(width: number, height: number, numberofparticles: number, numberofsources: number, isadvanced = false, sizecontrol = false, additionalbytes = 0) {
    this.seg = SEGMENT;
    this.framebuffer = SEGMENT.pixels;
    this.numSources = numberofsources;
    this.numParticles = numberofparticles;
    this.usedParticles = numberofparticles;
    this.particles = new Particles2D(numberofparticles);
    this.src = new Particles2D(numberofsources);
    this.srcMinLife = new Uint16Array(numberofsources); this.srcMaxLife = new Uint16Array(numberofsources);
    this.srcVar = new Int8Array(numberofsources); this.srcVx = new Int8Array(numberofsources); this.srcVy = new Int8Array(numberofsources);
    this.srcSize = new Uint8Array(numberofsources);
    if (isadvanced) {
      this.advSize = new Uint8Array(numberofparticles);
      this.advForce = new Uint8Array(numberofparticles);
      if (sizecontrol) {
        const u = () => new Uint8Array(numberofparticles);
        this.sc = {
          asymmetry: u(), asymdir: u(), maxsize: u(), minsize: u(), sizecounter: u(), wobblecounter: u(), growspeed: u(),
          shrinkspeed: u(), wobblespeed: u(), grow: u(), shrink: u(), pulsate: u(), wobble: u(),
        };
      }
    }
    this.extra = new Uint8Array((Math.max(0, additionalbytes) + 3) & ~3);
    this.extra32 = new Uint32Array(this.extra.buffer);
    this.extraI8 = new Int8Array(this.extra.buffer);
    this.binIndices = new Uint16Array(Math.max(50, numberofparticles + 1));
    this.binLx = new Int32Array(this.binIndices.length);
    this.binLy = new Int32Array(this.binIndices.length);
    this.binSz = new Uint16Array(this.binIndices.length);
    this.setMatrixSize(width, height);
    this.setWallHardness(255);
    this.setWallRoughness(0);
    this.setGravity(0);
    this.setParticleSize(1);
    this.motionBlur = 0;
    this.smearBlur = 0;
    this.emitIndex = 0;
    this.collisionStartIdx = 0;
    this.particles.sat.fill(255);
    this.src.sat.fill(255);
    this.src.ttl.fill(1);
    this.src.flags.fill(0);
    this.perParticleSize = isadvanced;
  }

  update(): void {
    const n = this.usedParticles, P = this.particles;
    if (this.settings & PS2_GRAVITY) this.applyGravityAll();
    if (this.sc) {
      for (let i = 0; i < n; i++) if (!this.updateSize(i)) P.ttl[i] = 0;
    }
    if (this.settings & PS2_COLLISIONS) this.handleCollisions();
    const adv = this.advSize !== null;
    for (let i = 0; i < n; i++) this.particleMoveUpdate(P, i, -1, adv);
    this.render();
  }

  updateFire(intensity: number): void {
    this.fireParticleupdate();
    intensity &= 0xff;
    this.fireIntesity = intensity > 0 ? intensity : 1;
    this.render();
  }

  setUsedParticles(percentage: number): void {
    percentage &= 0xff;
    this.usedParticles = Math.max(1, (this.numParticles * (percentage + 1)) >>> 8);
  }
  setWallHardness(h: number): void { this.wallHardness = h & 0xff; }
  setWallRoughness(r: number): void { this.wallRoughness = r & 0xff; }
  setCollisionHardness(h: number): void { this.collisionHardness = (h & 0xff) + 1; }
  setMatrixSize(x: number, y: number): void {
    this.maxXpixel = x - 1; this.maxYpixel = y - 1;
    this.maxX = x * PS_P_RADIUS - 1; this.maxY = y * PS_P_RADIUS - 1;
  }
  private setBit(bit: number, enable: boolean | number): void { if (enable) this.settings |= bit; else this.settings &= ~bit; }
  setWrapX(e: boolean | number): void { this.setBit(PS2_WRAPX, e); }
  setWrapY(e: boolean | number): void { this.setBit(PS2_WRAPY, e); }
  setBounceX(e: boolean | number): void { this.setBit(PS2_BOUNCEX, e); }
  setBounceY(e: boolean | number): void { this.setBit(PS2_BOUNCEY, e); }
  setKillOutOfBounds(e: boolean | number): void { this.setBit(PS2_KILL, e); }
  setColorByAge(e: boolean | number): void { this.setBit(PS2_COLORBYAGE, e); }
  setMotionBlur(b: number): void { this.motionBlur = b & 0xff; }
  setSmearBlur(b: number): void { this.smearBlur = b & 0xff; }
  setParticleSize(size: number): void {
    this.particlesize = size & 0xff;
    this.particleHardRadius = PS_P_MINHARDRADIUS;
    this.perParticleSize = false;
    if (this.particlesize > 1) this.particleHardRadius = PS_P_MINHARDRADIUS + ((this.particlesize * 52) >> 6);
    else if (this.particlesize === 0) this.particleHardRadius = PS_P_MINHARDRADIUS >> 1;
  }
  setGravity(force = 8): void {
    force = s8(force);
    if (force) { this.gforce = force; this.settings |= PS2_GRAVITY; } else this.settings &= ~PS2_GRAVITY;
  }
  enableParticleCollisions(enable: boolean | number, hardness = 255): void {
    this.setBit(PS2_COLLISIONS, enable);
    this.collisionHardness = (hardness & 0xff) + 1;
  }

  /** sprayEmit(sources[e]) → index of the emitted particle or -1. */
  sprayEmit(e: number): number {
    const P = this.particles, S = this.src, used = this.usedParticles;
    for (let i = 0; i < used; i++) {
      this.emitIndex++;
      if (this.emitIndex >= used) this.emitIndex = 0;
      const k = this.emitIndex;
      if (P.ttl[k] === 0) {
        const v = this.srcVar[e]!;
        let dx = hw_random16(v << 1) - v;
        let dy = hw_random16(v << 1) - v;
        if (v > 5) {
          while (dx * dx + dy * dy > v * v) {
            dx = hw_random16(v << 1) - v;
            dy = hw_random16(v << 1) - v;
          }
        }
        P.vx[k] = this.srcVx[e]! + dx;
        P.vy[k] = this.srcVy[e]! + dy;
        P.x[k] = S.x[e]!;
        P.y[k] = S.y[e]!;
        P.hue[k] = S.hue[e]!;
        P.sat[k] = S.sat[e]!;
        P.flags[k] = (P.flags[k]! & ~PF2_COLLIDE) | (S.flags[e]! & PF2_COLLIDE);
        P.ttl[k] = hw_random16(this.srcMinLife[e]!, this.srcMaxLife[e]!);
        if (this.advSize) this.advSize[k] = this.srcSize[e]!;
        return k;
      }
    }
    return -1;
  }
  flameEmit(e: number): void {
    const k = this.sprayEmit(e);
    if (k > 0) this.particles.ttl[k] = this.particles.ttl[k]! + this.src.ttl[e]!;
  }
  angleEmit(e: number, angle: number, speed: number): number {
    angle &= 0xffff;
    this.srcVx[e] = Math.trunc((cos16_t(angle) * speed) / 32600);
    this.srcVy[e] = Math.trunc((sin16_t(angle) * speed) / 32600);
    return this.sprayEmit(e);
  }

  /** particleMoveUpdate(part, partFlags, options, advancedproperties): options < 0 uses the system settings; adv uses advPartProps[i]. */
  particleMoveUpdate(P: Particles2D, i: number, options = -1, adv = false): void {
    const o = options < 0 ? this.settings : options;
    let ttl = P.ttl[i]!;
    if (ttl === 0) return;
    if (!(P.flags[i]! & PF2_PERPETUAL)) { ttl--; P.ttl[i] = ttl; }
    if (o & PS2_COLORBYAGE) P.hue[i] = ttl < 255 ? ttl : 255;

    let renderradius = PS_P_HALFRADIUS - 1 + this.particlesize;
    let newX = P.x[i]! + P.vx[i]!;
    let newY = P.y[i]! + P.vy[i]!;
    P.flags[i] = P.flags[i]! & ~PF2_OUTOFBOUNDS;

    if (this.perParticleSize && adv && this.advSize) {
      const size = this.advSize[i]!;
      renderradius = PS_P_HALFRADIUS - 1 + size;
      if (size > 0) this.particleHardRadius = PS_P_MINHARDRADIUS + ((size * 52) >> 6);
      else this.particleHardRadius = PS_P_MINHARDRADIUS >> 1;
    }
    const hr = this.particleHardRadius;
    if (o & PS2_BOUNCEY) {
      if (newY < hr || (newY > this.maxY - hr && !(o & PS2_GRAVITY))) {
        newY = this.bounce(P.vy[i]!, P.vx[i]!, newY, this.maxY);
        P.vy[i] = this.bIn; P.vx[i] = this.bPar;
      }
    }
    newY = checkBoundsAndWrap(newY, this.maxY, renderradius, (o & PS2_WRAPY) !== 0);
    if (!cbInBounds) {
      P.flags[i] = P.flags[i]! | PF2_OUTOFBOUNDS;
      if (o & PS2_KILL) {
        if (newY < 0) P.ttl[i] = 0;
        else if (!(o & PS2_GRAVITY)) P.ttl[i] = 0;
      }
    }
    if (P.ttl[i]) {
      if (o & PS2_BOUNCEX) {
        if (newX < hr || newX > this.maxX - hr) {
          newX = this.bounce(P.vx[i]!, P.vy[i]!, newX, this.maxX);
          P.vx[i] = this.bIn; P.vy[i] = this.bPar;
        }
      } else {
        newX = checkBoundsAndWrap(newX, this.maxX, renderradius, (o & PS2_WRAPX) !== 0);
        if (!cbInBounds) {
          P.flags[i] = P.flags[i]! | PF2_OUTOFBOUNDS;
          if (o & PS2_KILL) P.ttl[i] = 0;
        }
      }
    }
    P.x[i] = newX;
    P.y[i] = newY;
  }

  private fireParticleupdate(): void {
    const P = this.particles, n = this.usedParticles, maxX = this.maxX, maxY = this.maxY;
    const wrapX = (this.settings & PS2_WRAPX) !== 0;
    for (let i = 0; i < n; i++) {
      let ttl = P.ttl[i]!;
      if (ttl > 0) {
        ttl--; P.ttl[i] = ttl;
        const newY = P.y[i]! + P.vy[i]! + (ttl >> 2);
        let newX = P.x[i]! + P.vx[i]!;
        P.flags[i] = P.flags[i]! & ~PF2_OUTOFBOUNDS;
        if (newY < -PS_P_HALFRADIUS) P.flags[i] = P.flags[i]! | PF2_OUTOFBOUNDS;
        else if (newY > maxY + PS_P_HALFRADIUS) P.ttl[i] = 0;
        else {
          if (newX < 0 || newX > maxX) {
            if (wrapX) {
              newX = newX % (maxX + 1);
              if (newX < 0) newX += maxX + 1;
            } else if (newX < -PS_P_HALFRADIUS || newX > maxX + PS_P_HALFRADIUS) P.ttl[i] = 0;
          }
          P.x[i] = newX;
        }
        P.y[i] = newY;
      }
    }
  }

  /** updateSize(&advPartProps[i], &advPartSize[i]) */
  private updateSize(i: number): boolean {
    const sc = this.sc, advSize = this.advSize;
    if (!sc || !advSize) return false;
    let newsize = advSize[i]!;
    let counter = sc.sizecounter[i]!;
    let increment = 0;
    const grow = sc.grow[i]!, shrink = sc.shrink[i]!;
    if (grow) increment = sc.growspeed[i]!;
    else if (shrink) increment = sc.shrinkspeed[i]!;
    if (increment < 9) {
      counter += increment;
      if (counter > 7) { counter -= 8; increment = 1; } else increment = 0;
      sc.sizecounter[i] = counter & 0xf;
    } else increment = (increment - 8) << 1;

    if (grow) {
      if (newsize < sc.maxsize[i]!) {
        newsize += increment;
        if (newsize >= sc.maxsize[i]!) {
          sc.grow[i] = 0;
          newsize = sc.maxsize[i]!;
          if (sc.pulsate[i]) sc.shrink[i] = 1;
        }
      }
    } else if (shrink) {
      if (newsize > sc.minsize[i]!) {
        newsize -= increment;
        if (newsize <= sc.minsize[i]!) {
          if (sc.minsize[i] === 0) return false;
          sc.shrink[i] = 0;
          newsize = sc.minsize[i]!;
          if (sc.pulsate[i]) sc.grow[i] = 1;
        }
      }
    }
    advSize[i] = newsize;
    if (sc.wobble[i]) sc.asymdir[i] = sc.asymdir[i]! + sc.wobblespeed[i]!;
    return true;
  }

  private xsize = 0; private ysize = 0;
  private getParticleXYsize(i: number): void {
    const sc = this.sc, advSize = this.advSize;
    if (!sc || !advSize) return;
    const size = advSize[i]!;
    const asymdir = sc.asymdir[i]!;
    let deviation = (size * sc.asymmetry[i]! + 255) >>> 8;
    if (asymdir < 64) deviation = (asymdir * deviation) >> 6;
    else if (asymdir < 192) deviation = ((128 - asymdir) * deviation) >> 6;
    else deviation = ((asymdir - 255) * deviation) >> 6;
    this.xsize = Math.min(size - deviation, 255) >>> 0;
    this.ysize = Math.min(size + deviation, 255) >>> 0;
  }

  /** bounce(incomingspeed&, parallelspeed&, position&, maxposition): returns position, speeds in bIn / bPar. */
  private bounce(incomingspeed: number, parallelspeed: number, position: number, maxposition: number): number {
    incomingspeed = s8(-incomingspeed);
    incomingspeed = s8((incomingspeed * this.wallHardness + 128) >> 8);
    if (position < this.particleHardRadius) position = this.particleHardRadius;
    else position = maxposition - this.particleHardRadius;
    if (this.wallRoughness) {
      const incomingspeed_abs = Math.abs(incomingspeed);
      const totalspeed = incomingspeed_abs + Math.abs(parallelspeed);
      let donatespeed = Math.trunc(((hw_random16(incomingspeed_abs << 1) - incomingspeed_abs) * this.wallRoughness) / 255);
      parallelspeed = s8(limitSpeed(parallelspeed + donatespeed));
      donatespeed = s8(totalspeed - Math.abs(parallelspeed));
      incomingspeed = s8(incomingspeed > 0 ? donatespeed : -donatespeed);
    }
    this.bIn = incomingspeed; this.bPar = parallelspeed;
    return position;
  }

  /** applyForce(part, xforce, yforce, counter&): returns the counter's new value. */
  applyForceTo(P: Particles2D, i: number, xforce: number, yforce: number, counter: number): number {
    let xcounter = counter & 0x0f;
    let ycounter = (counter & 0xff) >> 4;
    const dvx = calcForce_dv(xforce, xcounter); xcounter = fcCounter;
    const dvy = calcForce_dv(yforce, ycounter); ycounter = fcCounter;
    counter = (xcounter & 0x0f) | ((ycounter << 4) & 0xf0);
    P.vx[i] = limitSpeed(P.vx[i]! + dvx);
    P.vy[i] = limitSpeed(P.vy[i]! + dvy);
    return counter;
  }
  /** applyForce(particleindex, xforce, yforce): uses advPartProps[i].forcecounter. */
  applyForce(i: number, xforce: number, yforce: number): void {
    if (!this.advForce) return;
    this.advForce[i] = this.applyForceTo(this.particles, i, xforce, yforce, this.advForce[i]!);
  }
  /** applyForce(xforce, yforce) on all used particles. */
  applyForceAll(xforce: number, yforce: number): void {
    let tempcounter = 0;
    for (let i = 0; i < this.usedParticles; i++) {
      tempcounter = this.forcecounter;
      tempcounter = this.applyForceTo(this.particles, i, xforce, yforce, tempcounter);
    }
    this.forcecounter = tempcounter;
  }
  applyAngleForceTo(P: Particles2D, i: number, force: number, angle: number, counter: number): number {
    force = s8(force);
    const xforce = s8(Math.trunc((force * cos16_t(angle)) / 32767));
    const yforce = s8(Math.trunc((force * sin16_t(angle)) / 32767));
    return this.applyForceTo(P, i, xforce, yforce, counter);
  }
  applyAngleForce(i: number, force: number, angle: number): void {
    if (!this.advForce) return;
    this.advForce[i] = this.applyAngleForceTo(this.particles, i, force, angle, this.advForce[i]!);
  }
  applyAngleForceAll(force: number, angle: number): void {
    force = s8(force);
    const xforce = s8(Math.trunc((force * cos16_t(angle)) / 32767));
    const yforce = s8(Math.trunc((force * sin16_t(angle)) / 32767));
    this.applyForceAll(xforce, yforce);
  }
  private applyGravityAll(): void {
    const dv = calcForce_dv(this.gforce, this.gforcecounter);
    this.gforcecounter = fcCounter;
    if (dv === 0) return;
    const vy = this.particles.vy;
    for (let i = 0; i < this.usedParticles; i++) vy[i] = limitSpeed(vy[i]! - dv);
  }
  /** applyGravity(part): for sources; does not advance the gravity counter. */
  applyGravity(P: Particles2D, i: number): void {
    const dv = calcForce_dv(this.gforce, this.gforcecounter);
    P.vy[i] = limitSpeed(P.vy[i]! - dv);
  }
  applyFrictionTo(P: Particles2D, i: number, coefficient: number): void {
    const friction = 255 - coefficient;
    P.vx[i] = Math.trunc((P.vx[i]! * friction) / 255);
    P.vy[i] = Math.trunc((P.vy[i]! * friction) / 255);
  }
  applyFriction(coefficient: number): void {
    const friction = 255 - coefficient, vx = this.particles.vx, vy = this.particles.vy;
    for (let i = 0; i < this.usedParticles; i++) {
      vx[i] = Math.trunc((vx[i]! * friction) / 255);
      vy[i] = Math.trunc((vy[i]! * friction) / 255);
    }
  }
  /** pointAttractor(particleindex, attractor (A, ai), strength, swallow) */
  pointAttractor(i: number, A: Particles2D, ai: number, strength: number, swallow: boolean | number): void {
    if (!this.advForce) return;
    const P = this.particles;
    const dx = A.x[ai]! - P.x[i]!;
    const dy = A.y[ai]! - P.y[i]!;
    let distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 8192) {
      if (swallow) {
        if (P.ttl[i]! > 7) P.ttl[i] = P.ttl[i]! - 8;
        else { P.ttl[i] = 0; return; }
      }
      distanceSquared = 2 * PS_P_RADIUS * PS_P_RADIUS;
    }
    const force = Math.trunc(((strength & 0xff) << 16) / distanceSquared);
    const xforce = s8(Math.trunc((force * dx) / 1024));
    const yforce = s8(Math.trunc((force * dy) / 1024));
    this.applyForce(i, xforce, yforce);
  }

  private render(): void {
    const fb = this.framebuffer, P = this.particles, pal = SEGPALETTE;
    const blend = this.settings & PS2_COLORBYAGE ? LINEARBLEND_NOWRAP : LINEARBLEND;
    const npx = (this.maxXpixel + 1) * (this.maxYpixel + 1);
    if (this.motionBlur) {
      const mb = this.motionBlur;
      for (let k = 0; k < npx; k++) {
        const c = fb[k]!;
        if (c) fb[k] = ((((c & 0x00ff00ff) * mb) >>> 8) & 0x00ff00ff) | ((((c >>> 8) & 0x00ff00ff) * mb) & 0xff00ff00);
      }
    } else fb.fill(0, 0, npx);

    const wrapX = (this.settings & PS2_WRAPX) !== 0, wrapY = (this.settings & PS2_WRAPY) !== 0;
    const fire = this.fireIntesity;
    for (let i = 0; i < this.usedParticles; i++) {
      const ttl = P.ttl[i]!;
      if (ttl === 0 || P.flags[i]! & PF2_OUTOFBOUNDS) continue;
      let brightness: number, baseRGB: number;
      if (fire) {
        brightness = ttl * (3 + (fire >> 5)) + 5;
        if (brightness > 255) brightness = 255;
        baseRGB = ColorFromPalette(pal, brightness, 255, LINEARBLEND_NOWRAP);
      } else {
        brightness = ttl << 1;
        if (brightness > 255) brightness = 255;
        baseRGB = ColorFromPalette(pal, P.hue[i]!, 255, blend);
        const sat = P.sat[i]!;
        if (sat < 255) {
          rgb2hsv(baseRGB, hsvTmp);
          if (sat < hsvTmp.s) hsvTmp.s = sat;
          baseRGB = hsv2rgb_spectrum(hsvTmp.h, hsvTmp.s, hsvTmp.v, baseRGB >>> 24);
        }
      }
      if (gammaCorrectCol) brightness = gamma8(brightness);
      this.renderParticle(i, brightness, baseRGB, wrapX, wrapY);
    }
    if (this.smearBlur) this.seg.blur2D(this.smearBlur, this.smearBlur, true);
  }

  private renderParticle(i: number, brightness: number, color: number, wrapX: boolean, wrapY: boolean): void {
    const P = this.particles, fb = this.framebuffer;
    let size = this.particlesize;
    if (this.perParticleSize && this.advSize) size = 1 + this.advSize[i]!;
    const maxXpixel = this.maxXpixel, maxYpixel = this.maxYpixel, W = maxXpixel + 1;

    if (size === 0) {
      const x = (P.x[i]! >> PS_P_RADIUS_SHIFT) >>> 0;
      const y = (P.y[i]! >> PS_P_RADIUS_SHIFT) >>> 0;
      if (x <= maxXpixel && y <= maxYpixel) {
        const index = x + (maxYpixel - y) * W;
        fb[index] = fast_color_scaleAdd(fb[index]!, color, brightness);
      }
      return;
    }
    if (size > 1) { this.renderLargeParticle(size, i, brightness, color, wrapX, wrapY); return; }

    const xoffset = P.x[i]! + PS_P_HALFRADIUS;
    const yoffset = P.y[i]! + PS_P_HALFRADIUS;
    const dx = xoffset & (PS_P_RADIUS - 1);
    const dy = yoffset & (PS_P_RADIUS - 1);
    let x = xoffset >> PS_P_RADIUS_SHIFT;
    let y = yoffset >> PS_P_RADIUS_SHIFT;
    // pixel order: bottom left [0], bottom right [1], top right [2], top left [3]
    let x1 = x, y2 = y; // x of [1],[2]; y of [2],[3]
    x--; y--;
    let x0 = x, y0 = y; // x of [0],[3]; y of [0],[1]
    const precal1 = PS_P_RADIUS - dx;
    const precal2 = (PS_P_RADIUS - dy) * brightness;
    const precal3 = dy * brightness;
    let b0 = ((precal1 * precal2) >> PS_P_SURFACE) & 0xff;
    let b1 = ((dx * precal2) >> PS_P_SURFACE) & 0xff;
    let b2 = ((dx * precal3) >> PS_P_SURFACE) & 0xff;
    let b3 = ((precal1 * precal3) >> PS_P_SURFACE) & 0xff;
    if (gammaCorrectCol) { b0 = gamma8inv(b0); b1 = gamma8inv(b1); b2 = gamma8inv(b2); b3 = gamma8inv(b3); }
    let v0 = true, v1 = true, v2 = true, v3 = true;
    if (x0 < 0) {
      if (wrapX) x0 = maxXpixel;
      else { v0 = v3 = false; if (x0 < -1) return; }
    } else if (x1 > maxXpixel) {
      if (wrapX) x1 = 0;
      else { v1 = v2 = false; if (x0 > maxXpixel) return; }
    }
    if (y0 < 0) {
      if (wrapY) y0 = maxYpixel;
      else { v0 = v1 = false; if (y0 < -1) return; }
    } else if (y2 > maxYpixel) {
      if (wrapY) y2 = 0;
      else { v2 = v3 = false; if (y2 > maxYpixel + 1) return; }
    }
    let idx: number;
    if (v0) { idx = x0 + (maxYpixel - y0) * W; fb[idx] = fast_color_scaleAdd(fb[idx]!, color, b0); }
    if (v1) { idx = x1 + (maxYpixel - y0) * W; fb[idx] = fast_color_scaleAdd(fb[idx]!, color, b1); }
    if (v2) { idx = x1 + (maxYpixel - y2) * W; fb[idx] = fast_color_scaleAdd(fb[idx]!, color, b2); }
    if (v3) { idx = x0 + (maxYpixel - y2) * W; fb[idx] = fast_color_scaleAdd(fb[idx]!, color, b3); }
  }

  private renderLargeParticle(size: number, i: number, brightness: number, color: number, wrapX: boolean, wrapY: boolean): void {
    const P = this.particles, fb = this.framebuffer;
    const x_subcenter = P.x[i]!, y_subcenter = P.y[i]!;
    const x_center = x_subcenter >> PS_P_RADIUS_SHIFT;
    const y_center = y_subcenter >> PS_P_RADIUS_SHIFT;
    let xsize = size, ysize = size;
    if (this.sc && this.sc.asymmetry[i]! > 0) { this.getParticleXYsize(i); xsize = this.xsize; ysize = this.ysize; }
    const rx_subpixel = (xsize + PS_P_RADIUS + 1) | 0;
    const ry_subpixel = (ysize + PS_P_RADIUS + 1) | 0;
    const rx_pixels = rx_subpixel >> PS_P_RADIUS_SHIFT;
    const ry_pixels = ry_subpixel >> PS_P_RADIUS_SHIFT;
    const x_min = x_center - rx_pixels, x_max = x_center + rx_pixels;
    const y_min = y_center - ry_pixels, y_max = y_center + ry_pixels;
    const matrixX = this.maxXpixel + 1, matrixY = this.maxYpixel + 1;
    const maxXpixel = this.maxXpixel, maxYpixel = this.maxYpixel;
    const rx_sq = (rx_subpixel * rx_subpixel) >>> 0, ry_sq = (ry_subpixel * ry_subpixel) >>> 0;
    for (let py = y_min; py <= y_max; py++) {
      let render_y = py;
      if (render_y < 0) { if (!wrapY) continue; render_y += matrixY; } else if (render_y > maxYpixel) { if (!wrapY) continue; render_y -= matrixY; }
      const dy_subpixel = (py << PS_P_RADIUS_SHIFT) - y_subcenter + PS_P_HALFRADIUS;
      for (let px = x_min; px <= x_max; px++) {
        let render_x = px;
        if (render_x < 0) { if (!wrapX) continue; render_x += matrixX; } else if (render_x > maxXpixel) { if (!wrapX) continue; render_x -= matrixX; }
        const dx_subpixel = (px << PS_P_RADIUS_SHIFT) - x_subcenter + PS_P_HALFRADIUS;
        let pixel_brightness = calculateEllipseBrightness(dx_subpixel, dy_subpixel, rx_sq, ry_sq, brightness);
        if (pixel_brightness === 0) continue;
        if (gammaCorrectCol) pixel_brightness = gamma8inv(pixel_brightness);
        const idx = render_x + (maxYpixel - render_y) * matrixX;
        fb[idx] = fast_color_scaleAdd(fb[idx]!, color, pixel_brightness);
      }
    }
  }

  private handleCollisions(): void {
    const P = this.particles, used = this.usedParticles, maxX = this.maxX;
    const px = P.x, py = P.y, pvx = P.vx, pvy = P.vy, pttl = P.ttl, pflags = P.flags;
    let collDistSq = (this.particleHardRadius << 1) >>> 0;
    collDistSq = collDistSq * collDistSq;
    let binWidth = 6 * PS_P_RADIUS;
    let overlap = this.particleHardRadius << 1;
    const perSize = this.perParticleSize && this.advSize !== null;
    const advSize = this.advSize;
    if (perSize) overlap = 512;
    const maxBinParticles = Math.max(50, (used + 1) >>> 1);
    let numBins = Math.floor((maxX + (binWidth - 1)) / binWidth);
    if (used < maxBinParticles) { numBins = 1; binWidth = maxX + 1; }
    const binIndices = this.binIndices;
    let nextFrameStartIdx = hw_random16(used);
    let pidx = this.collisionStartIdx;

    for (let bin = 0; bin < numBins; bin++) {
      let binParticleCount = 0;
      const binStart = bin * binWidth - overlap;
      const binEnd = binStart + binWidth + (overlap << 1);
      for (let i = 0; i < used; i++) {
        if (pttl[pidx]! > 0) {
          const x = px[pidx]!;
          if (x >= binStart && x <= binEnd) {
            const f = pflags[pidx]!;
            if ((f & PF2_OUTOFBOUNDS) === 0 && f & PF2_COLLIDE) {
              if (binParticleCount >= maxBinParticles) { nextFrameStartIdx = pidx; break; }
              binIndices[binParticleCount++] = pidx;
            }
          }
        }
        pidx++;
        if (pidx >= used) pidx = 0;
      }

      // look-ahead positions (x + vx, y + vy) of the binned particles; only collideParticles() changes them, so the
      // two entries are refreshed after each call (same values and order as reading the particles every time)
      const blx = this.binLx, bly = this.binLy, bsz = this.binSz;
      for (let k = 0; k < binParticleCount; k++) {
        const idx = binIndices[k]!;
        blx[k] = px[idx]! + pvx[idx]!;
        bly[k] = py[idx]! + pvy[idx]!;
        if (perSize) bsz[k] = advSize![idx]!;
      }
      let massratio1 = 0, massratio2 = 0;
      for (let i = 0; i < binParticleCount; i++) {
        const idx_i = binIndices[i]!;
        let xi = blx[i]!, yi = bly[i]!;
        const si = bsz[i]!;
        for (let j = i + 1; j < binParticleCount; j++) {
          if (perSize) collDistSq = COLLDISTSQ_BY_SIZESUM[si + bsz[j]!]!;
          const dx = blx[j]! - xi;
          if (dx * dx < collDistSq) {
            const dy = bly[j]! - yi;
            if (dy * dy < collDistSq) {
              const idx_j = binIndices[j]!;
              if (perSize) { // mass ratios are only read by collideParticles(), so they are worked out here
                let mass1 = PS_P_RADIUS + advSize![idx_i]!;
                let mass2 = PS_P_RADIUS + advSize![idx_j]!;
                mass1 = mass1 * mass1; mass2 = mass2 * mass2;
                const totalmass = mass1 + mass2;
                massratio1 = Math.floor((mass2 << 8) / totalmass);
                massratio2 = Math.floor((mass1 << 8) / totalmass);
              }
              this.collideParticles(idx_i, idx_j, dx, dy, collDistSq, massratio1, massratio2);
              blx[i] = xi = px[idx_i]! + pvx[idx_i]!; bly[i] = yi = py[idx_i]! + pvy[idx_i]!;
              blx[j] = px[idx_j]! + pvx[idx_j]!; bly[j] = py[idx_j]! + pvy[idx_j]!;
            }
          }
        }
      }
    }
    this.collisionStartIdx = nextFrameStartIdx & 0xffff;
  }

  private collideParticles(i1: number, i2: number, dx: number, dy: number, collDistSq: number, massratio1: number, massratio2: number): void {
    const P = this.particles, vx = P.vx, vy = P.vy;
    let distanceSquared = dx * dx + dy * dy;
    let relativeVx = vx[i2]! - vx[i1]!;
    let relativeVy = vy[i2]! - vy[i1]!;
    if (distanceSquared === 0) {
      dx = -1;
      if (relativeVx < 0) dx = 1;
      else if (relativeVx === 0) relativeVx = 1;
      dy = -1;
      if (relativeVy < 0) dy = 1;
      else if (relativeVy === 0) relativeVy = 1;
      distanceSquared = 2;
    }
    const dotProduct = dx * relativeVx + dy * relativeVy;
    const ch = this.collisionHardness;
    if (dotProduct < 0) {
      const surfacehardness = Math.max(ch, PS_P_MINSURFACEHARDNESS >> 1);
      const impulse = Math.imul(Math.trunc(((-dotProduct) << 15) / distanceSquared), surfacehardness) >> 8;
      const ximpulse = Math.trunc(Math.imul(impulse, dx) / 32767);
      const yimpulse = Math.trunc(Math.imul(impulse, dy) / 32767);
      if (massratio1) {
        const vx1 = vx[i1]! - ((ximpulse * massratio1) >> 7);
        const vy1 = vy[i1]! - ((yimpulse * massratio1) >> 7);
        const vx2 = vx[i2]! + ((ximpulse * massratio2) >> 7);
        const vy2 = vy[i2]! + ((yimpulse * massratio2) >> 7);
        vx[i1] = limitSpeed(vx1); vy[i1] = limitSpeed(vy1);
        vx[i2] = limitSpeed(vx2); vy[i2] = limitSpeed(vy2);
      } else {
        vx[i1] = vx[i1]! - ximpulse; vy[i1] = vy[i1]! - yimpulse;
        vx[i2] = vx[i2]! + ximpulse; vy[i2] = vy[i2]! + yimpulse;
      }
      if (ch < PS_P_MINSURFACEHARDNESS && (SEGMENT.call & 0x07) === 0) {
        const coeff = ch + (255 - PS_P_MINSURFACEHARDNESS); // uint32: (int32)v * coeff is unsigned arithmetic in C
        vx[i1] = Math.floor((Math.imul(vx[i1]!, coeff) >>> 0) / 255);
        vy[i1] = Math.floor((Math.imul(vy[i1]!, coeff) >>> 0) / 255);
        vx[i2] = Math.floor((Math.imul(vx[i2]!, coeff) >>> 0) / 255);
        vy[i2] = Math.floor((Math.imul(vy[i2]!, coeff) >>> 0) / 255);
      }
    }
    if (distanceSquared < collDistSq && relativeVx * relativeVx + relativeVy * relativeVy < 50) {
      const fairlyrandom = dotProduct & 0x01;
      const pushamount = 1 + ((collDistSq - distanceSquared) >>> 13);
      const pushx = s8(dx > 0 ? -pushamount : pushamount);
      const pushy = s8(dy > 0 ? -pushamount : pushamount);
      if (ch < 5) {
        if (fairlyrandom) {
          vx[i1] = 0; vy[i1] = 0; vx[i2] = 0; vy[i2] = 0;
          P.x[i1] = P.x[i1]! + pushx;
          P.y[i1] = P.y[i1]! + pushy;
        }
      } else if (fairlyrandom) {
        vx[i1] = vx[i1]! + pushx;
        vy[i1] = vy[i1]! + pushy;
      } else {
        vx[i2] = vx[i2]! - pushx;
        vy[i2] = vy[i2]! - pushy;
      }
    }
  }

  /** updateSystem(): dimensions and framebuffer of the current segment. */
  updateSystem(): void {
    this.seg = SEGMENT;
    this.framebuffer = SEGMENT.pixels;
    this.setMatrixSize(SEGMENT.vWidth(), SEGMENT.vHeight());
  }
}

const systems2D = new WeakMap<Segment, ParticleSystem2D>();

/**
 * initParticleSystem2D on SEGMENT.call == 0 (creates the segment's system), else returns the existing one.
 * Returns null where WLED's init fails (not a matrix), so the FX falls back to static.
 */
export function getPS2D(requestedsources: number, additionalbytes = 0, advanced = false, sizecontrol = false): ParticleSystem2D | null {
  if (SEGMENT.call !== 0) return systems2D.get(SEGMENT) ?? null;
  systems2D.delete(SEGMENT);
  if (!strip.isMatrix) return null;
  const cols = SEGMENT.virtualWidth(), rows = SEGMENT.virtualHeight(), pixels = cols * rows;
  if (sizecontrol) advanced = true;
  const numparticles = calculateNumberOfParticles2D(pixels, advanced, sizecontrol);
  const numsources = calculateNumberOfSources2D(pixels, requestedsources);
  if (numparticles < 5) return null;
  const ps = new ParticleSystem2D(cols, rows, numparticles, numsources, advanced, sizecontrol, additionalbytes);
  systems2D.set(SEGMENT, ps);
  return ps;
}

// ---------------------------------------------------------------------------------------------
// 1D particle system
// ---------------------------------------------------------------------------------------------

export const PS_P_RADIUS_1D = 32;
export const PS_P_HALFRADIUS_1D = PS_P_RADIUS_1D >> 1;
export const PS_P_RADIUS_SHIFT_1D = 5;
export const PS_P_SURFACE_1D = 5;
export const PS_P_MINHARDRADIUS_1D = 32;
export const PS_P_MINSURFACEHARDNESS_1D = 120;
const MAXPARTICLES_1D = 2600, MAXSOURCES_1D = 64;

/** PSsettings1D bits. */
export const PS1_WRAP = 1, PS1_BOUNCE = 2, PS1_KILL = 4, PS1_GRAVITY = 8, PS1_COLLISIONS = 16, PS1_COLORBYAGE = 32, PS1_COLORBYPOS = 64;
/** PSparticleFlags1D bits. */
export const PF1_OUTOFBOUNDS = 1, PF1_COLLIDE = 2, PF1_PERPETUAL = 4, PF1_REVERSEGRAV = 8, PF1_FORCEDIR = 16, PF1_FIXED = 32, PF1_CUSTOM1 = 64, PF1_CUSTOM2 = 128;

/** An array of PSparticle1D (+ PSparticleFlags1D). */
export class Particles1D {
  readonly x: Int32Array; readonly ttl: Uint16Array; readonly vx: Int8Array; readonly hue: Uint8Array; readonly flags: Uint8Array;
  constructor(readonly length: number) {
    this.x = new Int32Array(length); this.ttl = new Uint16Array(length); this.vx = new Int8Array(length);
    this.hue = new Uint8Array(length); this.flags = new Uint8Array(length);
  }
}

export function calculateNumberOfParticles1D(fraction: number, isadvanced: boolean): number {
  let n = Math.min(SEGMENT.virtualLength(), MAXPARTICLES_1D);
  if (isadvanced) n = Math.floor((n * 8) / (8 + 3)); // sizeof(PSparticle1D) = 8, sizeof(PSadvancedParticle1D) = 3
  n = (n * ((fraction & 0xff) + 1)) >>> 8;
  n = n < 10 ? 10 : n;
  return (n + 3) & ~3;
}
export function calculateNumberOfSources1D(requestedsources: number): number {
  const n = Math.max(1, Math.min(requestedsources | 0, MAXSOURCES_1D));
  return (n + 3) & ~3;
}

export class ParticleSystem1D {
  readonly particles: Particles1D;
  /** sources[i].source / sourceFlags */
  readonly src: Particles1D;
  readonly srcMinLife: Uint16Array; readonly srcMaxLife: Uint16Array;
  readonly srcVar: Int8Array; readonly srcV: Int8Array; readonly srcSat: Uint8Array; readonly srcSize: Uint8Array;
  /** advPartProps (null when not advanced): sat, size, forcecounter */
  readonly advSat: Uint8Array | null = null;
  readonly advSize: Uint8Array | null = null;
  readonly advForce: Uint8Array | null = null;
  /** Bytes behind PSdataEnd for the FX (zeroed), with uint32 / int8 views. */
  readonly extra: Uint8Array;
  readonly extra32: Uint32Array;
  readonly extraI8: Int8Array;

  maxX = 0; maxXpixel = 0;
  readonly numSources: number;
  usedParticles: number;
  perParticleSize: boolean;
  readonly numParticles: number;
  settings = 0;

  private framebuffer: Uint32Array;
  private seg: Segment;
  private emitIndex = 0;
  private collisionHardness = 0;
  private particleHardRadius = 0;
  private wallHardness = 0;
  private gforcecounter = 0;
  private gforce = 0;
  private forcecounter = 0;
  private collisionStartIdx = 0;
  private particlesize = 0;
  private motionBlur = 0;
  private smearBlur = 0;
  private binIndices: Uint16Array;

  constructor(length: number, numberofparticles: number, numberofsources: number, isadvanced = false, additionalbytes = 0) {
    this.seg = SEGMENT;
    this.framebuffer = SEGMENT.pixels;
    this.numSources = numberofsources;
    this.numParticles = numberofparticles;
    this.usedParticles = numberofparticles;
    this.particles = new Particles1D(numberofparticles);
    this.src = new Particles1D(numberofsources);
    this.srcMinLife = new Uint16Array(numberofsources); this.srcMaxLife = new Uint16Array(numberofsources);
    this.srcVar = new Int8Array(numberofsources); this.srcV = new Int8Array(numberofsources);
    this.srcSat = new Uint8Array(numberofsources); this.srcSize = new Uint8Array(numberofsources);
    if (isadvanced) {
      this.advSat = new Uint8Array(numberofparticles).fill(255);
      this.advSize = new Uint8Array(numberofparticles);
      this.advForce = new Uint8Array(numberofparticles);
    }
    this.extra = new Uint8Array((Math.max(0, additionalbytes) + 3) & ~3);
    this.extra32 = new Uint32Array(this.extra.buffer);
    this.extraI8 = new Int8Array(this.extra.buffer);
    this.binIndices = new Uint16Array(Math.max(50, numberofparticles + 1));
    this.setSize(length);
    this.setWallHardness(255);
    this.setGravity(0);
    this.setParticleSize(0);
    this.src.ttl.fill(1);
    this.src.flags.fill(0);
    this.perParticleSize = isadvanced;
  }

  update(): void {
    const n = this.usedParticles, P = this.particles;
    if (this.settings & PS1_GRAVITY) this.applyGravityAll();
    if (this.settings & PS1_COLLISIONS) {
      this.handleCollisions();
      if (this.perParticleSize) this.handleCollisions();
    }
    const adv = this.advSize !== null;
    for (let i = 0; i < n; i++) this.particleMoveUpdate(P, i, -1, adv);
    if (this.settings & PS1_COLORBYPOS) {
      const scale = Math.floor((255 << 16) / this.maxX) >>> 0;
      for (let i = 0; i < n; i++) P.hue[i] = (Math.imul(scale, P.x[i]!) >>> 0) >>> 16;
    }
    this.render();
  }

  setUsedParticles(percentage: number): void {
    percentage &= 0xff;
    this.usedParticles = Math.max(1, (this.numParticles * (percentage + 1)) >>> 8);
  }
  setWallHardness(h: number): void { this.wallHardness = h & 0xff; }
  setSize(x: number): void { this.maxXpixel = x - 1; this.maxX = x * PS_P_RADIUS_1D - 1; }
  private setBit(bit: number, enable: boolean | number): void { if (enable) this.settings |= bit; else this.settings &= ~bit; }
  setWrap(e: boolean | number): void { this.setBit(PS1_WRAP, e); }
  setBounce(e: boolean | number): void { this.setBit(PS1_BOUNCE, e); }
  setKillOutOfBounds(e: boolean | number): void { this.setBit(PS1_KILL, e); }
  setColorByAge(e: boolean | number): void { this.setBit(PS1_COLORBYAGE, e); }
  setColorByPosition(e: boolean | number): void { this.setBit(PS1_COLORBYPOS, e); }
  setMotionBlur(b: number): void { this.motionBlur = b & 0xff; }
  setSmearBlur(b: number): void { this.smearBlur = b & 0xff; }
  setParticleSize(size: number): void {
    this.particlesize = size & 0xff;
    this.particleHardRadius = PS_P_MINHARDRADIUS_1D;
    this.perParticleSize = false;
    if (this.particlesize > 1) this.particleHardRadius = PS_P_MINHARDRADIUS_1D + ((this.particlesize * 52) >> 6);
    else if (this.particlesize === 0) this.particleHardRadius = PS_P_MINHARDRADIUS_1D >> 1;
  }
  setGravity(force = 8): void {
    force = s8(force);
    if (force) { this.gforce = force; this.settings |= PS1_GRAVITY; } else this.settings &= ~PS1_GRAVITY;
  }
  enableParticleCollisions(enable: boolean | number, hardness = 255): void {
    this.setBit(PS1_COLLISIONS, enable);
    this.collisionHardness = hardness & 0xff;
  }

  sprayEmit(e: number): number {
    const P = this.particles, S = this.src, used = this.usedParticles;
    for (let i = 0; i < used; i++) {
      this.emitIndex++;
      if (this.emitIndex >= used) this.emitIndex = 0;
      const k = this.emitIndex;
      if (P.ttl[k] === 0) {
        const v = this.srcVar[e]!;
        P.vx[k] = this.srcV[e]! + hw_random16(v << 1) - v;
        P.x[k] = S.x[e]!;
        P.hue[k] = S.hue[e]!;
        P.ttl[k] = hw_random16(this.srcMinLife[e]!, this.srcMaxLife[e]!);
        const sf = S.flags[e]!, mask = PF1_COLLIDE | PF1_REVERSEGRAV | PF1_PERPETUAL;
        P.flags[k] = (P.flags[k]! & ~mask) | (sf & mask);
        if (this.advSat) {
          this.advSat[k] = this.srcSat[e]!;
          this.advSize![k] = this.srcSize[e]!;
        }
        return k;
      }
    }
    return -1;
  }

  particleMoveUpdate(P: Particles1D, i: number, options = -1, adv = false): void {
    const o = options < 0 ? this.settings : options;
    let ttl = P.ttl[i]!;
    if (ttl === 0) return;
    const flags = P.flags[i]!;
    if (!(flags & PF1_PERPETUAL)) { ttl--; P.ttl[i] = ttl; }
    if (o & PS1_COLORBYAGE) P.hue[i] = ttl < 255 ? ttl : 255;

    let renderradius = PS_P_HALFRADIUS_1D - 1 + this.particlesize;
    let newX = P.x[i]! + P.vx[i]!;
    P.flags[i] = flags & ~PF1_OUTOFBOUNDS;

    if (this.perParticleSize && adv && this.advSize) {
      const size = this.advSize[i]!;
      renderradius = PS_P_HALFRADIUS_1D - 1 + size;
      if (size > 1) this.particleHardRadius = PS_P_MINHARDRADIUS_1D + ((size * 52) >> 6);
      else this.particleHardRadius = PS_P_MINHARDRADIUS_1D >> 1;
    }
    const hr = this.particleHardRadius, maxX = this.maxX;
    if (o & PS1_BOUNCE) {
      if (newX < hr || newX > maxX - hr) {
        let bouncethis = true;
        if (o & PS1_GRAVITY) {
          if (flags & PF1_REVERSEGRAV) { if (newX < hr) bouncethis = false; } else if (newX > hr) bouncethis = false;
        }
        if (bouncethis) {
          P.vx[i] = -P.vx[i]!;
          P.vx[i] = Math.trunc((P.vx[i]! * this.wallHardness) / 255);
          if (newX < hr) newX = hr;
          else newX = maxX - hr;
        }
      }
    }
    newX = checkBoundsAndWrap(newX, maxX, renderradius, (o & PS1_WRAP) !== 0);
    if (!cbInBounds) {
      P.flags[i] = P.flags[i]! | PF1_OUTOFBOUNDS;
      if (o & PS1_KILL) {
        let killthis = true;
        if (o & PS1_GRAVITY) {
          if (flags & PF1_REVERSEGRAV) { if (newX < 0 || newX > maxX << 2) killthis = false; } else if (newX > 0 && newX < maxX << 2) killthis = false;
        }
        if (killthis) P.ttl[i] = 0;
      }
    }
    if (!(flags & PF1_FIXED)) P.x[i] = newX;
    else P.vx[i] = 0;
  }

  /** applyForce(part, xforce, counter&): returns the counter's new value. */
  applyForceTo(P: Particles1D, i: number, xforce: number, counter: number): number {
    const dv = calcForce_dv(xforce, counter);
    P.vx[i] = limitSpeed(P.vx[i]! + dv);
    return fcCounter;
  }
  applyForce(xforce: number): void {
    const dv = calcForce_dv(xforce, this.forcecounter);
    this.forcecounter = fcCounter;
    const vx = this.particles.vx;
    for (let i = 0; i < this.usedParticles; i++) vx[i] = limitSpeed(vx[i]! + dv);
  }
  private applyGravityAll(): void {
    const dv_raw = calcForce_dv(this.gforce, this.gforcecounter);
    this.gforcecounter = fcCounter;
    const vx = this.particles.vx, flags = this.particles.flags;
    for (let i = 0; i < this.usedParticles; i++) {
      const dv = flags[i]! & PF1_REVERSEGRAV ? -dv_raw : dv_raw;
      vx[i] = limitSpeed(vx[i]! - dv);
    }
  }
  /** applyGravity(part, partFlags): for sources; does not advance the counter. */
  applyGravity(P: Particles1D, i: number): void {
    let dv = calcForce_dv(this.gforce, this.gforcecounter);
    if (P.flags[i]! & PF1_REVERSEGRAV) dv = -dv;
    P.vx[i] = limitSpeed(P.vx[i]! - dv);
  }
  applyFriction(coefficient: number): void {
    const friction = 255 - coefficient, P = this.particles;
    for (let i = 0; i < this.usedParticles; i++) if (P.ttl[i]) P.vx[i] = Math.trunc((P.vx[i]! * friction) / 255);
  }

  private render(): void {
    const fb = this.framebuffer, P = this.particles, pal = SEGPALETTE, n = this.maxXpixel + 1;
    const blend = this.settings & (PS1_COLORBYAGE | PS1_COLORBYPOS) ? LINEARBLEND_NOWRAP : LINEARBLEND;
    if (this.motionBlur) {
      const mb = this.motionBlur;
      for (let k = 0; k < n; k++) {
        const c = fb[k]!;
        if (c) fb[k] = ((((c & 0x00ff00ff) * mb) >>> 8) & 0x00ff00ff) | ((((c >>> 8) & 0x00ff00ff) * mb) & 0xff00ff00);
      }
    } else fb.fill(0, 0, n);

    const wrap = (this.settings & PS1_WRAP) !== 0, advSat = this.advSat;
    for (let i = 0; i < this.usedParticles; i++) {
      const ttl = P.ttl[i]!;
      if (ttl === 0 || P.flags[i]! & PF1_OUTOFBOUNDS) continue;
      let brightness = ttl << 1;
      if (brightness > 255) brightness = 255;
      let baseRGB = ColorFromPalette(pal, P.hue[i]!, 255, blend);
      if (advSat) {
        const sat = advSat[i]!;
        if (sat < 255) {
          rgb2hsv(baseRGB, hsvTmp);
          baseRGB = hsv2rgb_spectrum(hsvTmp.h, sat, hsvTmp.v, baseRGB >>> 24);
        }
      }
      if (gammaCorrectCol) brightness = gamma8(brightness);
      this.renderParticle(i, brightness, baseRGB, wrap);
    }
    if (this.smearBlur) this.seg.blur(this.smearBlur, true);
    const bg_color = SEGCOLOR(1);
    if (bg_color > 0) for (let k = 0; k < n; k++) fb[k] = fast_color_scaleAdd(fb[k]!, bg_color);
  }

  private renderParticle(i: number, brightness: number, color: number, wrap: boolean): void {
    const P = this.particles, fb = this.framebuffer, maxXpixel = this.maxXpixel;
    let size = this.particlesize;
    if (this.perParticleSize && this.advSize) size = 1 + this.advSize[i]!;
    if (size === 0) {
      const x = (P.x[i]! >> PS_P_RADIUS_SHIFT_1D) >>> 0;
      if (x <= maxXpixel) fb[x] = fast_color_scaleAdd(fb[x]!, color, brightness);
      return;
    }
    if (size > 1) { this.renderLargeParticle(size, i, brightness, color, wrap); return; }

    const xoffset = P.x[i]! + PS_P_HALFRADIUS_1D;
    const dx = xoffset & (PS_P_RADIUS_1D - 1);
    let p1 = xoffset >> PS_P_RADIUS_SHIFT_1D;
    let p0 = p1 - 1;
    let b0 = ((PS_P_RADIUS_1D - dx) * brightness) >> PS_P_SURFACE_1D;
    let b1 = (dx * brightness) >> PS_P_SURFACE_1D;
    if (gammaCorrectCol) { b0 = gamma8inv(b0); b1 = gamma8inv(b1); }
    let in0 = true, in1 = true;
    if (p0 < 0) {
      if (wrap) p0 = maxXpixel;
      else { in0 = false; if (p0 < -1) return; }
    } else if (p1 > maxXpixel) {
      if (wrap) p1 = 0;
      else { in1 = false; if (p0 > maxXpixel) return; }
    }
    if (in0) fb[p0] = fast_color_scaleAdd(fb[p0]!, color, b0);
    if (in1) fb[p1] = fast_color_scaleAdd(fb[p1]!, color, b1);
  }

  private renderLargeParticle(size: number, i: number, brightness: number, color: number, wrap: boolean): void {
    const fb = this.framebuffer, maxXpixel = this.maxXpixel;
    const x_subcenter = this.particles.x[i]!;
    const x_center = x_subcenter >> PS_P_RADIUS_SHIFT_1D;
    const r_subpixel = size + PS_P_RADIUS_1D + 1;
    const r_pixels = r_subpixel >> PS_P_RADIUS_SHIFT_1D;
    const x_min = x_center - r_pixels - 1, x_max = x_center + r_pixels + 1;
    const matrixX = maxXpixel + 1;
    const rx_sq = r_subpixel * r_subpixel;
    for (let px = x_min; px <= x_max; px++) {
      let render_x = px;
      if (render_x < 0) { if (!wrap) continue; render_x += matrixX; } else if (render_x > maxXpixel) { if (!wrap) continue; render_x -= matrixX; }
      let dx_sq = (px << PS_P_RADIUS_SHIFT_1D) - x_subcenter + PS_P_HALFRADIUS_1D;
      dx_sq = Math.imul(dx_sq, dx_sq);
      const dist_sq = Math.floor(((dx_sq << 8) >>> 0) / rx_sq);
      const pixel_brightness = dist_sq >= 256 ? 0 : (((256 - dist_sq) * brightness) >> 8) & 0xff;
      fb[render_x] = fast_color_scaleAdd(fb[render_x]!, color, pixel_brightness);
    }
  }

  private handleCollisions(): void {
    const P = this.particles, used = this.usedParticles, maxX = this.maxX;
    const px = P.x, pttl = P.ttl, pflags = P.flags;
    const collisiondistance = (this.particleHardRadius << 1) >>> 0;
    let checkDistSq = Math.max(2 * PS_P_MAXSPEED, collisiondistance);
    const perSize = this.perParticleSize && this.advSize !== null;
    if (perSize) checkDistSq = Math.max(2 * PS_P_MAXSPEED, (512 * 52) >> 6);
    checkDistSq = checkDistSq * checkDistSq;
    let binWidth = 64 * PS_P_RADIUS_1D;
    let overlap = collisiondistance + 2 * PS_P_MAXSPEED;
    if (perSize) overlap = 512;
    const maxBinParticles = Math.max(50, (used + 1) >>> 2);
    let numBins = Math.floor((maxX + (binWidth - 1)) / binWidth);
    if (used < maxBinParticles) { numBins = 1; binWidth = maxX + 1; }
    const binIndices = this.binIndices;
    let nextFrameStartIdx = hw_random16(used);
    let pidx = this.collisionStartIdx;
    for (let bin = 0; bin < numBins; bin++) {
      let binParticleCount = 0;
      const binStart = bin * binWidth - overlap;
      const binEnd = binStart + binWidth + (overlap << 1);
      for (let i = 0; i < used; i++) {
        if (pttl[pidx]! > 0) {
          const x = px[pidx]!;
          if (x >= binStart && x <= binEnd) {
            const f = pflags[pidx]!;
            if ((f & PF1_OUTOFBOUNDS) === 0 && f & PF1_COLLIDE) {
              if (binParticleCount >= maxBinParticles) { nextFrameStartIdx = pidx; break; }
              binIndices[binParticleCount++] = pidx;
            }
          }
        }
        pidx++;
        if (pidx >= used) pidx = 0;
      }
      for (let i = 0; i < binParticleCount; i++) {
        const idx_i = binIndices[i]!;
        for (let j = i + 1; j < binParticleCount; j++) {
          const idx_j = binIndices[j]!;
          const dx = px[idx_j]! - px[idx_i]!;
          const dx_sq = Math.imul(dx, dx) >>> 0;
          if (dx_sq <= checkDistSq) this.collideParticles(idx_i, idx_j, dx, collisiondistance);
        }
      }
    }
    this.collisionStartIdx = nextFrameStartIdx & 0xffff;
  }

  private collideParticles(i1: number, i2: number, dx: number, collisiondistance: number): void {
    const P = this.particles, vx = P.vx, x = P.x, flags = P.flags;
    let massratio1 = 0, massratio2 = 0;
    if (this.perParticleSize && this.advSize) {
      const s1 = this.advSize[i1]!, s2 = this.advSize[i2]!;
      collisiondistance = PS_P_MINHARDRADIUS_1D * 2 + (((s1 + s2) * 52) >>> 6);
      const mass1 = PS_P_RADIUS_1D + s1, mass2 = PS_P_RADIUS_1D + s2;
      const totalmass = mass1 + mass2 - 2;
      massratio1 = Math.floor((mass2 << 8) / totalmass);
      massratio2 = Math.floor((mass1 << 8) / totalmass);
    }
    const dv = vx[i2]! - vx[i1]!;
    const absdv = Math.abs(dv);
    const dotProduct = Math.imul(dx, dv);
    const dx_abs = Math.abs(dx);
    const ch = this.collisionHardness;
    if (dotProduct < 0) {
      const lookaheadDistance = collisiondistance + absdv;
      if (dx_abs <= lookaheadDistance) {
        if (flags[i1]! & PF1_FIXED) {
          vx[i2] = Math.trunc(-(vx[i2]! * ch) / 255);
          x[i2] = x[i1]! + (dx < 0 ? -collisiondistance : collisiondistance);
          return;
        } else if (flags[i2]! & PF1_FIXED) {
          vx[i1] = Math.trunc(-(vx[i1]! * ch) / 255);
          x[i1] = x[i2]! + (dx < 0 ? collisiondistance : -collisiondistance);
          return;
        }
        const surfacehardness = Math.max(ch, PS_P_MINSURFACEHARDNESS_1D);
        const impulse = Math.trunc((dv * surfacehardness) / 255);
        if (massratio1) {
          const vx1 = vx[i1]! + ((impulse * massratio1) >> 7);
          const vx2 = vx[i2]! - ((impulse * massratio2) >> 7);
          vx[i1] = limitSpeed(vx1);
          vx[i2] = limitSpeed(vx2);
        } else {
          vx[i1] = vx[i1]! + impulse;
          vx[i2] = vx[i2]! - impulse;
        }
        if (ch < PS_P_MINSURFACEHARDNESS_1D && (SEGMENT.call & 0x07) === 0) {
          const coeff = ch + (250 - PS_P_MINSURFACEHARDNESS_1D); // uint32 in C: unsigned product
          vx[i1] = Math.floor((Math.imul(vx[i1]!, coeff) >>> 0) / 255);
          vx[i2] = Math.floor((Math.imul(vx[i2]!, coeff) >>> 0) / 255);
        }
      } else return;
    }
    if (dx_abs < collisiondistance) {
      let pushamount = 1 + ((collisiondistance - dx_abs) >>> 3);
      let addspeed = 1;
      if (dx < 0) { pushamount = -pushamount; addspeed = -addspeed; }
      if (absdv < 4) {
        vx[i1] = vx[i1]! - addspeed;
        vx[i2] = vx[i2]! + addspeed;
      }
      if (dotProduct & 0x01) x[i1] = x[i1]! - pushamount;
      else x[i2] = x[i2]! + pushamount;
    }
  }

  updateSystem(): void {
    this.seg = SEGMENT;
    this.framebuffer = SEGMENT.pixels;
    this.setSize(SEGMENT.vLength());
  }
}

const systems1D = new WeakMap<Segment, ParticleSystem1D>();

/** initParticleSystem1D on SEGMENT.call == 0, else the segment's existing system; null where WLED's init fails. */
export function getPS1D(requestedsources: number, fractionofparticles = 255, additionalbytes = 0, advanced = false): ParticleSystem1D | null {
  if (SEGMENT.call !== 0) return systems1D.get(SEGMENT) ?? null;
  systems1D.delete(SEGMENT);
  if (SEGLEN === 1) return null;
  const numparticles = calculateNumberOfParticles1D(fractionofparticles, advanced);
  const numsources = calculateNumberOfSources1D(requestedsources);
  const ps = new ParticleSystem1D(SEGMENT.virtualLength(), numparticles, numsources, advanced, additionalbytes);
  systems1D.set(SEGMENT, ps);
  return ps;
}

export { s8, s16 };
