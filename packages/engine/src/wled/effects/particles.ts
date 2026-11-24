// Ported from WLED v16.0.1 (https://github.com/wled/WLED), wled00/FX.cpp. Copyright (c) 2016-present Christian Schwinne and individual WLED contributors. Licensed under the EUPL v. 1.2 or later.
// Particle system effects by DedeHai (Damian Schneider).
//
// The FXparticleSystem effects ("PS ..."), on the particle system port in ../particle-system.ts.
// Deviations from FX.cpp:
// - The particle system lives in a per-segment object (getPS2D / getPS1D) instead of SEGENV.data.
// - PS Fuzzy Noise seeds aux0 with hw_random() instead of libc rand().
// - PS Attractor: no audio-reactive usermod, so the mass is always the speed slider (as WLED without AR).
// - ESP8266-only branches are left out (the controller is an ESP32).

import type { EffectDef } from '../../effects.js';
import { wledEffect } from '../define.js';
import { cos16_t, cos8_t, cubicwave8, hw_random, hw_random16, hw_random8, map, perlin8, sin16_t, sqrt32_bw } from '../math.js';
import {
  getPS1D, getPS2D, Particles2D, PF1_COLLIDE, PF1_CUSTOM1, PF1_FIXED, PF1_OUTOFBOUNDS, PF1_PERPETUAL, PF1_REVERSEGRAV,
  PF2_COLLIDE, PF2_PERPETUAL, PS_P_HALFRADIUS, PS_P_MAXSPEED, PS_P_MINSURFACEHARDNESS, PS_P_RADIUS, PS_P_RADIUS_1D,
  PS2_BOUNCEX, PS2_BOUNCEY, PS2_GRAVITY, PS2_WRAPX, PS2_WRAPY, s16, s8, type ParticleSystem2D,
} from '../particle-system.js';
import { SEGCOLOR, SEGENV, SEGLEN, SEGMENT, strip } from '../segment.js';

const FX_FALLBACK_STATIC = (): void => { SEGMENT.fill(SEGCOLOR(0)); };
const b = (v: boolean): number => (v ? 1 : 0);
const min = Math.min, max = Math.max, trunc = Math.trunc;

/** FX.cpp tristate_square8 */
function tristate_square8(x: number, pulsewidth: number, attdec: number): number {
  x &= 0xff;
  let a = 127;
  if (x > 127) { a = -127; x = (x - 127) & 0xff; }
  if (x < attdec) return s8(trunc((x * a) / attdec));
  else if (x < pulsewidth - attdec) return a;
  else if (x < pulsewidth) return s8(trunc(((pulsewidth - x) * a) / attdec));
  return 0;
}

// ============================================================================================
// 2D
// ============================================================================================

/*
  Particle System Vortex
  Particles sprayed from center with a rotating spray
*/
function mode_particlevortex(): void {
  if (SEGLEN === 1) return FX_FALLBACK_STATIC();
  const NUMBEROFSOURCES = 8;
  const PartSys = getPS2D(NUMBEROFSOURCES);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  let i: number, j: number;
  if (SEGMENT.call === 0) {
    PartSys.setMotionBlur(130);
    for (i = 0; i < min(PartSys.numSources, NUMBEROFSOURCES); i++) {
      S.x[i] = (PartSys.maxX + 1) >> 1;
      S.y[i] = (PartSys.maxY + 1) >> 1;
      PartSys.srcMaxLife[i] = 900;
      PartSys.srcMinLife[i] = 800;
    }
    PartSys.setKillOutOfBounds(true);
  }
  PartSys.updateSystem();
  const spraycount = min(PartSys.numSources, 1 + (SEGMENT.custom1 >> 5));

  if (SEGMENT.check1) PartSys.setSmearBlur(90);
  else PartSys.setSmearBlur(0);

  for (i = 0; i < spraycount; i++) {
    const coloroffset = trunc(0xff / spraycount);
    S.hue[i] = coloroffset * i;
  }

  let direction = SEGMENT.check2;
  let currentspeed = SEGENV.step | 0;
  if (SEGMENT.custom2 > 0) {
    let changeinterval = 1040 - (SEGMENT.custom2 << 2);
    direction = (SEGENV.aux1 & 0x01) !== 0;
    if (SEGMENT.check3) changeinterval = 20 + changeinterval + hw_random16(changeinterval);
    if (SEGMENT.call % changeinterval === 0) {
      SEGENV.aux1 |= 0x02;
      if (direction) SEGENV.aux1 &= ~0x01;
      else SEGENV.aux1 |= 0x01;
    }
  }
  const targetspeed = (direction ? 1 : -1) * (SEGMENT.speed << 3);
  const speeddiff = targetspeed - currentspeed;
  let speedincrement = trunc(speeddiff / 50);
  if (speedincrement === 0) {
    if (speeddiff < 0) speedincrement = -1;
    else if (speeddiff > 0) speedincrement = 1;
  }
  currentspeed += speedincrement;
  SEGENV.aux0 += currentspeed;
  SEGENV.step = currentspeed >>> 0;

  const angleoffset = trunc(0xffff / spraycount) & 0xffff;
  const skip = trunc(PS_P_HALFRADIUS / (SEGMENT.intensity + 1)) + 1;
  if (SEGMENT.call % skip === 0) {
    j = hw_random16(spraycount);
    for (i = 0; i < spraycount; i++) {
      PartSys.srcVar[j] = SEGMENT.custom3 >> 1;
      PartSys.angleEmit(j, SEGENV.aux0 + angleoffset * j, (SEGMENT.intensity >> 2) + 1);
      j = (j + 1) % spraycount;
    }
  }
  PartSys.update();
}

/*
  Particle Fireworks
  Rockets shoot up and explode in a random color, sometimes in a defined pattern
*/
function mode_particlefireworks(): void {
  const NUMBEROFSOURCES = 8;
  const PartSys = getPS2D(NUMBEROFSOURCES);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  let numRockets: number;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setWallHardness(120);
    numRockets = min(PartSys.numSources, NUMBEROFSOURCES);
    for (let j = 0; j < numRockets; j++) {
      S.ttl[j] = 500 * j;
      S.vy[j] = -1;
    }
  }
  PartSys.updateSystem();
  numRockets = map(SEGMENT.speed, 0, 255, 4, min(PartSys.numSources, NUMBEROFSOURCES));

  PartSys.setWrapX(SEGMENT.check1);
  PartSys.setBounceY(SEGMENT.check2);
  PartSys.setGravity(map(SEGMENT.custom3, 0, 31, SEGMENT.check2 ? 1 : 0, 10));
  PartSys.setMotionBlur(map(SEGMENT.custom2, 0, 255, 0, 245));

  for (let j = 0; j < numRockets; j++) {
    PartSys.applyGravity(S, j);
    PartSys.particleMoveUpdate(S, j);
    if (S.ttl[j] === 0) {
      if (S.vy[j]! > 0) S.vy[j] = 0;
      else if (S.vy[j]! < 0) {
        S.y[j] = PS_P_RADIUS;
        S.x[j] = (PartSys.maxX >> 2) + hw_random(PartSys.maxX >> 1);
        S.vy[j] = SEGMENT.custom3 + hw_random16(SEGMENT.custom1 >> 3) + 5;
        S.vx[j] = hw_random16(7) - 3;
        S.sat[j] = 30;
        S.ttl[j] = hw_random16(SEGMENT.custom1) + (SEGMENT.custom1 >> 1);
        PartSys.srcMaxLife[j] = 40;
        PartSys.srcMinLife[j] = 10;
        PartSys.srcVx[j] = 0;
        PartSys.srcVy[j] = -5;
        PartSys.srcVar[j] = 4;
      }
    }
  }
  let emitparticles: number, frequency = 0, baseangle = 0, hueincrement = 0;
  let speed = 0, currentspeed = 0, percircle = 0;
  let counter = 0;
  let angle = 0, angleincrement = 0;
  let circularexplosion = false;

  for (let j = 0; j < numRockets; j++) {
    if (S.vy[j]! > 0) emitparticles = 1;
    else if (S.vy[j]! < 0) emitparticles = 0;
    else {
      S.hue[j] = hw_random16();
      S.sat[j] = hw_random16(55) + 200;
      PartSys.srcMaxLife[j] = 200;
      PartSys.srcMinLife[j] = 100;
      S.ttl[j] = hw_random16(2000 - (SEGMENT.speed << 2)) + 550 - (SEGMENT.speed << 1);
      PartSys.srcVar[j] = (SEGMENT.intensity >> 4) + 5;
      S.vy[j] = -1;
      emitparticles = hw_random16(SEGMENT.intensity >> 2) + (SEGMENT.intensity >> 2) + 5;
      if (hw_random() & 1) {
        circularexplosion = true;
        speed = 2 + hw_random16(3) + (SEGMENT.intensity >> 6);
        currentspeed = speed;
        angleincrement = 2730 + hw_random16(5461);
        angle = hw_random16();
        baseangle = angle;
        percircle = trunc(0xffff / angleincrement) + 1;
        hueincrement = hw_random16() & 127;
        const circles = 1 + hw_random16(3) + (SEGMENT.intensity >> 6);
        frequency = hw_random16() & 127;
        emitparticles = percircle * circles;
        PartSys.srcVar[j] = angle & 1;
      }
    }
    let i: number;
    for (i = 0; i < emitparticles; i++) {
      if (circularexplosion) {
        const sineMod = 0xefff + sin16_t((((angle * frequency) >>> 4) + baseangle) & 0xffff);
        currentspeed = (trunc(speed / 2) + ((sineMod * speed) >> 16)) >> 1;
        PartSys.angleEmit(j, angle, currentspeed);
        counter++;
        if (counter > percircle) {
          counter = 0;
          speed += 3 + (SEGMENT.intensity >> 6);
          S.hue[j] = S.hue[j]! + hueincrement;
          S.sat[j] = 100 + hw_random16(156);
        }
        angle = (angle + angleincrement) & 0xffff;
      } else {
        PartSys.sprayEmit(j);
        if (j % 3 === 0) S.hue[j] = hw_random16();
      }
    }
    if (i === 0) S.y[j] = 1000;
    circularexplosion = false;
  }
  if (SEGMENT.check3) {
    for (let i = 0; i < PartSys.usedParticles; i++) PartSys.particleMoveUpdate(PartSys.particles, i, -1, false);
  }
  PartSys.update();
}

/*
  Particle Volcano
  Particles are sprayed from below, spray moves back and forth if option is set
*/
function mode_particlevolcano(): void {
  const NUMBEROFSOURCES = 1;
  const volcanosettings = PS2_BOUNCEX;
  const PartSys = getPS2D(NUMBEROFSOURCES);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  let numSprays: number, i: number;
  if (SEGMENT.call === 0) {
    PartSys.setBounceY(true);
    PartSys.setGravity();
    PartSys.setKillOutOfBounds(true);
    PartSys.setMotionBlur(230);
    numSprays = min(PartSys.numSources, NUMBEROFSOURCES);
    for (i = 0; i < numSprays; i++) {
      S.hue[i] = hw_random16();
      S.x[i] = trunc(PartSys.maxX / (numSprays + 1)) * (i + 1);
      PartSys.srcMaxLife[i] = 300;
      PartSys.srcMinLife[i] = 250;
      S.flags[i] = S.flags[i]! | PF2_COLLIDE | PF2_PERPETUAL;
    }
  }
  numSprays = min(PartSys.numSources, NUMBEROFSOURCES);

  if (SEGMENT.call % (11 - trunc(SEGMENT.intensity / 25)) === 0) {
    for (i = 0; i < numSprays; i++) {
      S.y[i] = PS_P_RADIUS + 5;
      S.vy[i] = 0;
      S.hue[i] = S.hue[i]! + 1;
      S.vx[i] = S.vx[i]! > 0 ? SEGMENT.custom1 >> 2 : -(SEGMENT.custom1 >> 2);
      PartSys.srcVy[i] = SEGMENT.speed >> 2;
      PartSys.srcVx[i] = 0;
      PartSys.srcVar[i] = SEGMENT.custom3 >> 1;
      PartSys.sprayEmit(i);
      PartSys.setWallHardness(255);
      PartSys.particleMoveUpdate(S, i, volcanosettings);
    }
  }
  PartSys.updateSystem();
  PartSys.setColorByAge(SEGMENT.check1);
  PartSys.setBounceX(SEGMENT.check2);
  PartSys.setWallHardness(SEGMENT.custom2);
  if (SEGMENT.check3) PartSys.enableParticleCollisions(true, SEGMENT.custom2);
  else PartSys.enableParticleCollisions(false);
  PartSys.update();
}

/*
  Particle Fire
  realistic fire effect using particles. heat based and using perlin-noise for wind
*/
function mode_particlefire(): void {
  let i: number;
  const PartSys = getPS2D(SEGMENT.vWidth(), 4);
  if (!PartSys) return FX_FALLBACK_STATIC();
  if (SEGMENT.call === 0) SEGENV.aux0 = hw_random16();
  const S = PartSys.src, P = PartSys.particles;

  PartSys.updateSystem();
  PartSys.setWrapX(SEGMENT.check2);
  PartSys.setMotionBlur(b(SEGMENT.check1) * 170);
  PartSys.setSmearBlur(b(!SEGMENT.check1) * 60);

  const firespeed = max(100, SEGMENT.speed);
  if (SEGMENT.speed < 100) {
    const lastcall = PartSys.extra32;
    const period = (strip.now - lastcall[0]!) >>> 0;
    if (period < map(SEGMENT.speed, 0, 99, 50, 10) >>> 0) {
      SEGMENT.call--;
      return;
    }
    lastcall[0] = strip.now;
  }

  const spread = ((PartSys.maxX >> 5) * (SEGMENT.custom3 + 1)) >>> 0;
  const numFlames = min(PartSys.numSources, 4 + ((trunc(spread / PS_P_RADIUS)) << 1));
  const percycle = trunc((numFlames * 2) / 3);

  for (i = 0; i < numFlames; i++) {
    if (SEGMENT.call & 1 && S.ttl[i]! > 0) {
      S.ttl[i] = S.ttl[i]! - 1;
    } else {
      S.x[i] = (PartSys.maxX >> 1) - (spread >> 1) + hw_random(spread);
      S.y[i] = -(PS_P_RADIUS << 2);
      S.ttl[i] = 20 + trunc(hw_random16((SEGMENT.custom1 * SEGMENT.custom1) >> 8) / (1 + (firespeed >> 5)));
      PartSys.srcMaxLife[i] = hw_random16(SEGMENT.vHeight() >> 1) + 16;
      PartSys.srcMinLife[i] = PartSys.srcMaxLife[i]! >> 1;
      PartSys.srcVx[i] = hw_random16(5) - 2;
      PartSys.srcVy[i] = (SEGMENT.vHeight() >> 1) + (firespeed >> 4) + (SEGMENT.custom1 >> 4);
      PartSys.srcVar[i] = 2 + hw_random16(2 + (firespeed >> 4));
    }
  }

  if (SEGMENT.call % 3 === 0) {
    SEGENV.aux0++;
    if (SEGMENT.call % 10 === 0) SEGENV.aux1++;
    const windspeed = s8(((s16(perlin8(SEGENV.aux0, SEGENV.aux1) - 127)) * SEGMENT.custom2) >> 7);
    PartSys.applyForceAll(windspeed, 0);
  }
  SEGENV.step++;

  if (SEGMENT.check3) {
    if (SEGMENT.call % map(firespeed, 0, 255, 4, 15) === 0) {
      for (i = 0; i < PartSys.usedParticles; i++) {
        if (P.y[i]! < trunc(PartSys.maxY / 4)) {
          const curl = perlin8(P.x[i]!, P.y[i]!, SEGENV.step << 4) - 127;
          P.vx[i] = P.vx[i]! + ((curl * (firespeed + 10)) >> 9);
        }
      }
    }
  }

  if (hw_random8() < 10 + (SEGMENT.intensity >> 2)) {
    for (i = 0; i < PartSys.usedParticles; i++) {
      if (P.ttl[i] === 0) {
        P.ttl[i] = hw_random16(SEGMENT.vHeight()) + 30;
        P.x[i] = S.x[0]!;
        P.y[i] = S.y[0]!;
        P.vx[i] = S.vx[0]!;
        P.vy[i] = (SEGMENT.vHeight() >> 1) + (firespeed >> 4) + ((30 + (SEGMENT.intensity >> 1) + SEGMENT.custom1) >> 4);
        break;
      }
    }
  }

  let j = hw_random16() & 0xff;
  for (i = 0; i < percycle; i++) {
    j = ((j + 1) % numFlames) & 0xff;
    PartSys.flameEmit(j);
  }
  PartSys.updateFire(SEGMENT.intensity);
}

/*
  PS Ballpit: particles falling down, user can enable these three options: X-wraparound, side bounce, ground bounce
*/
function mode_particlepit(): void {
  const PartSys = getPS2D(0, 0, true, false);
  if (!PartSys) return FX_FALLBACK_STATIC();
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setGravity();
    PartSys.setUsedParticles(170);
  }
  const P = PartSys.particles;
  PartSys.updateSystem();
  PartSys.setWrapX(SEGMENT.check1);
  PartSys.setBounceX(SEGMENT.check2);
  PartSys.setBounceY(SEGMENT.check3);
  PartSys.setWallHardness(min(SEGMENT.custom2, 150));
  if (SEGMENT.custom2 > 0) PartSys.enableParticleCollisions(true, SEGMENT.custom2);
  else PartSys.enableParticleCollisions(false);

  if (SEGMENT.call % (128 - (SEGMENT.intensity >> 1)) === 0 && SEGMENT.intensity > 0) {
    for (let i = 0; i < PartSys.usedParticles; i++) {
      if (P.ttl[i] === 0) {
        P.ttl[i] = 1500 - (SEGMENT.speed << 2) + hw_random16(500);
        P.x[i] = hw_random(PartSys.maxX);
        P.y[i] = PartSys.maxY << 1;
        P.vx[i] = s16(hw_random16(SEGMENT.speed >> 1)) - (SEGMENT.speed >> 2);
        P.vy[i] = map(SEGMENT.speed, 0, 255, -5, -100);
        P.hue[i] = hw_random16();
        P.flags[i] = P.flags[i]! | PF2_COLLIDE;
        P.sat[i] = (SEGMENT.custom3 << 3) + 7;
        if (SEGMENT.custom1 === 255) {
          PartSys.perParticleSize = true;
          PartSys.advSize![i] = hw_random16(SEGMENT.custom1);
        } else {
          PartSys.setParticleSize(SEGMENT.custom1);
          PartSys.advSize![i] = SEGMENT.custom1;
        }
        break;
      }
    }
  }
  let frictioncoefficient = 1 + b(SEGMENT.check1);
  if (SEGMENT.speed < 50) frictioncoefficient = 50 - SEGMENT.speed;
  if (SEGMENT.call % 6 === 0) PartSys.applyFriction(frictioncoefficient);
  PartSys.update();
}

/*
  Particle Waterfall
  Uses palette for particle color, spray source at top emitting particles, many config options
*/
function mode_particlewaterfall(): void {
  const PartSys = getPS2D(12);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  let i: number;
  if (SEGMENT.call === 0) {
    PartSys.setGravity();
    PartSys.setKillOutOfBounds(true);
    PartSys.setMotionBlur(190);
    PartSys.setSmearBlur(30);
    for (i = 0; i < PartSys.numSources; i++) {
      S.hue[i] = i * 90;
      S.flags[i] = S.flags[i]! | PF2_COLLIDE;
      PartSys.srcMaxLife[i] = 400;
      PartSys.srcMinLife[i] = 150;
    }
  }
  PartSys.updateSystem();
  PartSys.setWrapX(SEGMENT.check1);
  PartSys.setBounceX(SEGMENT.check2);
  PartSys.setBounceY(SEGMENT.check3);
  PartSys.setWallHardness(SEGMENT.custom2);
  const numSprays = min(PartSys.numSources, max(trunc(PartSys.maxXpixel / 6), 2)) & 0xff;
  if (SEGMENT.custom2 > 0) PartSys.enableParticleCollisions(true, SEGMENT.custom2);
  else {
    PartSys.enableParticleCollisions(false);
    PartSys.setWallHardness(120);
  }
  for (i = 0; i < numSprays; i++) S.hue[i] = S.hue[i]! + 1 + hw_random16(SEGMENT.custom1 >> 1);

  if (SEGMENT.call % (12 - (SEGMENT.intensity >> 5)) === 0 && SEGMENT.intensity > 0) {
    for (i = 0; i < numSprays; i++) {
      PartSys.srcVy[i] = -SEGMENT.speed >> 3;
      S.x[i] = map(SEGMENT.custom3, 0, 31, 0, (PartSys.maxXpixel - numSprays) * PS_P_RADIUS) + i * PS_P_RADIUS * 2;
      S.y[i] = PartSys.maxY + PS_P_RADIUS * ((i << 2) + 4);
      PartSys.srcVar[i] = SEGMENT.custom1 >> 3;
      PartSys.sprayEmit(i);
    }
  }
  if (SEGMENT.call % 20 === 0) PartSys.applyFriction(1);
  PartSys.update();
}

/*
  Particle Box, applies gravity to particles in either a random direction or random but only downwards (sloshing)
*/
function mode_particlebox(): void {
  const PartSys = getPS2D(1, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  if (SEGMENT.call === 0) {
    PartSys.setBounceX(true);
    PartSys.setBounceY(true);
    SEGENV.aux0 = hw_random16();
  }
  const P = PartSys.particles;
  PartSys.updateSystem();
  PartSys.setWallHardness(min(SEGMENT.custom2, 200));
  PartSys.enableParticleCollisions(true, max(2, SEGMENT.custom2));
  const maxParticleSize = min((SEGMENT.vWidth() * SEGMENT.vHeight()) >> 2, 255);
  const currentParticleSize = map(SEGMENT.custom3, 0, 31, 0, maxParticleSize) >>> 0;
  PartSys.setUsedParticles(trunc(map(SEGMENT.intensity, 0, 255, 2, 153) / (1 + (currentParticleSize >> 4))));
  if (SEGMENT.custom3 < 31) PartSys.setParticleSize(currentParticleSize);
  else PartSys.perParticleSize = true;

  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i]! < 260) {
      P.ttl[i] = 260;
      P.x[i] = hw_random16(PartSys.maxX);
      P.y[i] = hw_random16(PartSys.maxY);
      P.hue[i] = hw_random8();
      P.flags[i] = P.flags[i]! | PF2_PERPETUAL | PF2_COLLIDE;
      PartSys.advSize![i] = hw_random8(maxParticleSize);
      break;
    }
  }

  if (SEGMENT.call % (((255 - SEGMENT.speed) >> 6) + 1) === 0 && SEGMENT.speed > 0) {
    let xgravity: number, ygravity: number;
    const increment = (SEGMENT.speed >> 6) + 1;
    if (SEGMENT.check2) {
      const speed = trunc(tristate_square8(strip.now >>> 7, 90, 15) / ((400 - SEGMENT.speed) >> 3));
      SEGENV.aux0 += speed;
      if (speed === 0) SEGENV.aux0 = 190;
    } else SEGENV.aux0 -= increment;

    if (SEGMENT.check1) {
      xgravity = perlin8(SEGENV.aux0) - 127;
      ygravity = perlin8((SEGENV.aux0 + 10000) & 0xffff) - 127;
      xgravity = trunc((xgravity * SEGMENT.custom1) / 128);
      ygravity = trunc((ygravity * SEGMENT.custom1) / 128);
    } else {
      xgravity = trunc((SEGMENT.custom1 * cos16_t(SEGENV.aux0 << 8)) / 0xffff);
      ygravity = trunc((SEGMENT.custom1 * sin16_t(SEGENV.aux0 << 8)) / 0xffff);
    }
    if (SEGMENT.check3) {
      if (ygravity > 0) ygravity = -ygravity;
    }
    PartSys.applyForceAll(xgravity, ygravity);
  }
  if ((SEGMENT.call & 0x0f) === 0) PartSys.applyFriction(1);
  PartSys.update();
}

/*
  Fuzzy Noise: Perlin noise 'gravity' mapping as in particles on 'noise hills' viewed from above
*/
function mode_particleperlin(): void {
  const PartSys = getPS2D(1, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setMotionBlur(230);
    PartSys.setBounceY(true);
    SEGENV.aux0 = hw_random(); // C: rand()
  }
  const P = PartSys.particles;
  PartSys.updateSystem();
  PartSys.setWrapX(SEGMENT.check1);
  PartSys.setBounceX(!SEGMENT.check1);
  PartSys.setWallHardness(SEGMENT.custom1);
  PartSys.enableParticleCollisions(SEGMENT.check3, SEGMENT.custom1);
  PartSys.setUsedParticles(map(SEGMENT.intensity, 0, 255, 25, 128));
  PartSys.setSmearBlur(b(SEGMENT.check2) * 15);

  SEGENV.aux0 += 1 + (SEGMENT.speed >> 5);
  const scale = 16 - ((31 - SEGMENT.custom3) >> 1);
  const applyForce = SEGMENT.call % 8 === 0;
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i] === 0) {
      P.ttl[i] = hw_random16(500) + 200;
      P.x[i] = hw_random(PartSys.maxX);
      P.y[i] = hw_random(PartSys.maxY);
      P.flags[i] = P.flags[i]! | PF2_COLLIDE;
    }
    // int16 / uint32 is an unsigned division in C
    const xnoise = Math.floor((P.x[i]! >>> 0) / scale) & 0xffff;
    const ynoise = Math.floor((P.y[i]! >>> 0) / scale) & 0xffff;
    const baseheight = perlin8(xnoise, ynoise, SEGENV.aux0);
    P.hue[i] = baseheight;
    if (applyForce) {
      const xslope = s8(baseheight + perlin8(xnoise - 10, ynoise, SEGENV.aux0));
      const yslope = s8(baseheight + perlin8(xnoise, ynoise - 10, SEGENV.aux0));
      PartSys.applyForce(i, xslope, yslope);
    }
  }
  if (SEGMENT.call % (16 - (SEGMENT.custom2 >> 4)) === 0) PartSys.applyFriction(2);
  PartSys.update();
}

/*
  Particle smashing down like meteors and exploding as they hit the ground
*/
function mode_particleimpact(): void {
  const NUMBEROFSOURCES = 8;
  const meteorsettings = PS2_BOUNCEY | PS2_GRAVITY;
  const PartSys = getPS2D(NUMBEROFSOURCES);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  let numMeteors: number;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setGravity();
    PartSys.setBounceY(true);
    PartSys.setWallRoughness(220);
    numMeteors = min(PartSys.numSources, NUMBEROFSOURCES);
    for (let i = 0; i < numMeteors; i++) {
      S.ttl[i] = hw_random16(10 * i);
      S.vy[i] = 10;
    }
  }
  PartSys.updateSystem();
  PartSys.setWrapX(SEGMENT.check1);
  PartSys.setBounceX(SEGMENT.check2);
  PartSys.setMotionBlur(SEGMENT.custom3 << 3);
  const hardness = map(SEGMENT.custom2, 0, 255, PS_P_MINSURFACEHARDNESS - 2, 255) & 0xff;
  PartSys.setWallHardness(hardness);
  PartSys.enableParticleCollisions(SEGMENT.check3, hardness);
  numMeteors = min(PartSys.numSources, NUMBEROFSOURCES);
  let emitparticles: number;

  for (let i = 0; i < numMeteors; i++) {
    if (S.vy[i]! < 0) emitparticles = 1;
    else if (S.vy[i]! > 0) emitparticles = 0;
    else {
      S.vy[i] = 10;
      emitparticles = map(SEGMENT.intensity, 0, 255, 10, hw_random16(PartSys.usedParticles >> 2)) >>> 0;
    }
    for (let e = emitparticles | 0; e > 0; e--) PartSys.sprayEmit(i);
  }

  for (let i = 0; i < numMeteors; i++) {
    if (S.ttl[i]) {
      S.ttl[i] = S.ttl[i]! - 1;
      if (S.vy[i]! < 0) {
        PartSys.applyGravity(S, i);
        PartSys.particleMoveUpdate(S, i, meteorsettings);
        if (S.y[i]! < PS_P_RADIUS << 1) {
          S.vy[i] = 0;
          S.vx[i] = 0;
          S.flags[i] = S.flags[i]! | PF2_COLLIDE;
          PartSys.srcMaxLife[i] = 1250;
          PartSys.srcMinLife[i] = 250;
          S.ttl[i] = hw_random16(768 - (SEGMENT.speed << 1)) + 40;
          PartSys.srcVy[i] = SEGMENT.custom1 >> 2;
          PartSys.srcVar[i] = SEGMENT.custom1 >> 2;
        }
      }
    } else if (S.vy[i]! > 0) {
      S.y[i] = PartSys.maxY + (PS_P_RADIUS << 2);
      S.x[i] = hw_random(PartSys.maxX);
      S.vy[i] = -hw_random16(30) - 30;
      S.vx[i] = hw_random16(50) - 25;
      S.hue[i] = hw_random16();
      S.ttl[i] = 500;
      S.flags[i] = S.flags[i]! & ~PF2_COLLIDE;
      PartSys.srcMaxLife[i] = 300;
      PartSys.srcMinLife[i] = 100;
      PartSys.srcVy[i] = -9;
      PartSys.srcVar[i] = 3;
    }
  }
  for (let i = 0; i < PartSys.usedParticles; i++) if (P.ttl[i]! > 5) P.ttl[i] = P.ttl[i]! - 5;
  PartSys.update();
}

/*
  Particle Attractor, a particle attractor sits in the matrix center, a spray bounces around and seeds particles
*/
const attractors = new WeakMap<ParticleSystem2D, Particles2D>();
function mode_particleattractor(): void {
  const sourcesettings = PS2_BOUNCEX | PS2_BOUNCEY;
  const attractorFlags = 0;
  const PartSys = getPS2D(1, 10 /* sizeof(PSparticle) */, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  if (SEGMENT.call === 0) {
    attractors.set(PartSys, new Particles2D(1)); // the PSparticle behind PSdataEnd (zeroed)
    S.hue[0] = hw_random16();
    S.vx[0] = -7;
    S.flags[0] = S.flags[0]! | PF2_COLLIDE | PF2_PERPETUAL;
    PartSys.srcMaxLife[0] = 350;
    PartSys.srcMinLife[0] = 50;
    PartSys.srcVar[0] = 4;
    PartSys.setWallHardness(255);
    PartSys.setWallRoughness(200);
  }
  const A = attractors.get(PartSys)!;
  PartSys.updateSystem();
  PartSys.setColorByAge(SEGMENT.check1);
  PartSys.setParticleSize(SEGMENT.custom1 >> 1);
  PartSys.setUsedParticles(map(SEGMENT.intensity, 0, 255, 25, 190));
  A.ttl[0] = 100;
  if (SEGMENT.check2) {
    if (SEGMENT.call % 3 === 0) {
      A.flags[0] = attractorFlags;
      PartSys.particleMoveUpdate(A, 0, sourcesettings);
    }
  } else {
    A.x[0] = PartSys.maxX >> 1;
    A.y[0] = PartSys.maxY >> 1;
  }
  if (SEGMENT.call === 0) {
    A.vx[0] = S.vy[0]!;
    A.vy[0] = S.vx[0]!;
  }
  if (SEGMENT.custom2 > 0) PartSys.enableParticleCollisions(true, map(SEGMENT.custom2, 1, 255, 120, 255));
  else PartSys.enableParticleCollisions(false);

  if (SEGMENT.call % 5 === 0) S.hue[0] = S.hue[0]! + 1;

  SEGENV.aux0 += 256;
  if (SEGMENT.call % 2 === 0) PartSys.angleEmit(0, SEGENV.aux0, 12);
  else PartSys.angleEmit(0, SEGENV.aux0 + 0x7fff, 12);
  const strength = SEGMENT.speed;
  for (let i = 0; i < PartSys.usedParticles; i++) PartSys.pointAttractor(i, A, 0, strength, SEGMENT.check3);

  if (SEGMENT.call % (33 - SEGMENT.custom3) === 0) PartSys.applyFriction(2);
  PartSys.particleMoveUpdate(S, 0, sourcesettings);
  PartSys.update();
}

/*
  Particle replacement of Ghost Rider by DedeHai (Damian Schneider), original FX by stepko adapted by Blaz Kristan (AKA blazoncek)
*/
const MAXANGLESTEP = 2200;
function mode_particleghostrider(): void {
  let ghostsettings = PS2_WRAPX | PS2_WRAPY;
  const PartSys = getPS2D(1);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.srcMaxLife[0] = 260;
    PartSys.srcMinLife[0] = 250;
    S.x[0] = hw_random16(PartSys.maxX);
    S.y[0] = hw_random16(PartSys.maxY);
    SEGENV.step = hw_random16(MAXANGLESTEP) - (MAXANGLESTEP >> 1);
  }
  if (SEGMENT.intensity > 0) {
    if (SEGENV.aux1) {
      SEGENV.step += SEGMENT.intensity >> 3;
      if ((SEGENV.step | 0) > MAXANGLESTEP) SEGENV.aux1 = 0;
    } else {
      SEGENV.step -= SEGMENT.intensity >> 3;
      if ((SEGENV.step | 0) < -MAXANGLESTEP) SEGENV.aux1 = 1;
    }
  }
  PartSys.updateSystem();
  PartSys.setMotionBlur(SEGMENT.custom1);
  PartSys.srcVar[0] = SEGMENT.custom3 >> 1;

  if (SEGMENT.check1) {
    for (let i = 0; i < PartSys.usedParticles; i++) P.hue[i] = S.hue[0]! + (P.ttl[i]! << 2);
  }
  if (SEGMENT.check2) ghostsettings |= PS2_BOUNCEX | PS2_BOUNCEY;
  else ghostsettings &= ~(PS2_BOUNCEX | PS2_BOUNCEY);

  SEGENV.aux0 += SEGENV.step | 0;
  const emitangle = (SEGENV.aux0 + 32767) & 0xffff;
  const speed = map(SEGMENT.speed, 0, 255, 12, 64);
  S.vx[0] = trunc((cos16_t(SEGENV.aux0) * speed) / 32767);
  S.vy[0] = trunc((sin16_t(SEGENV.aux0) * speed) / 32767);
  S.ttl[0] = 500;
  PartSys.particleMoveUpdate(S, 0, ghostsettings);
  const head = PartSys.usedParticles - 1;
  P.x[head] = S.x[0]!;
  P.y[head] = S.y[0]!;
  P.ttl[head] = 255;
  P.sat[head] = 0;
  PartSys.angleEmit(0, emitangle, speed);
  PartSys.angleEmit(0, emitangle, speed);
  if (SEGMENT.call % (11 - trunc(SEGMENT.custom2 / 25)) === 0) S.hue[0] = S.hue[0]! + 1;
  if (SEGMENT.custom2 > 190) S.hue[0] = S.hue[0]! + ((SEGMENT.custom2 - 190) >> 2);
  PartSys.update();
}

/*
  Particle Galaxy, particles spiral like in a galaxy
*/
function mode_particlegalaxy(): void {
  const sourcesettings = PS2_BOUNCEX | PS2_BOUNCEY;
  const PartSys = getPS2D(1, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    S.vx[0] = -4;
    S.x[0] = PartSys.maxX >> 1;
    S.y[0] = PartSys.maxY >> 1;
    S.flags[0] = S.flags[0]! | PF2_PERPETUAL;
    PartSys.srcMaxLife[0] = 4000;
    PartSys.srcMinLife[0] = 800;
    S.hue[0] = hw_random16();
    PartSys.setWallHardness(255);
    PartSys.setWallRoughness(200);
  }
  PartSys.updateSystem();
  PartSys.setParticleSize(SEGMENT.custom1);
  PartSys.setMotionBlur(250 * b(SEGMENT.check3));

  if (SEGMENT.call % ((33 - SEGMENT.custom3) >> 1) === 0) S.hue[0] = S.hue[0]! + 2;
  if (hw_random8() < 10 + (SEGMENT.intensity >> 1)) PartSys.sprayEmit(0);
  if ((SEGMENT.call & 0x3) === 0) PartSys.particleMoveUpdate(S, 0, sourcesettings);

  const centerx = PartSys.maxX >> 1, centery = PartSys.maxY >> 1;
  if (SEGMENT.check2) {
    PartSys.setKillOutOfBounds(true);
    PartSys.srcVar[0] = 7;
    S.x[0] = centerx;
    S.y[0] = centery;
  } else {
    PartSys.setKillOutOfBounds(false);
    PartSys.srcVar[0] = 1;
  }
  const mapMax = (PartSys.maxX + PartSys.maxY) >> 2;
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i] === 0) continue;
    const dx = centerx - P.x[i]!;
    const dy = centery - P.y[i]!;
    let distance = sqrt32_bw(dx * dx + dy * dy);
    if (distance < 20) distance = 20;
    let speedfactor: number;
    if (SEGMENT.check2) {
      speedfactor = 1 + (1 + (SEGMENT.speed >> 1)) * distance;
      P.x[i] = P.x[i]! + trunc(Math.imul(-speedfactor, dx) / 400000) - (dy >> 6);
      P.y[i] = P.y[i]! + trunc(Math.imul(-speedfactor, dy) / 400000) + (dx >> 6);
    } else {
      speedfactor = 2 + trunc(((50 + SEGMENT.speed) << 6) / distance);
      const tempVx = -speedfactor * dy;
      const tempVy = speedfactor * dx;
      const vxc = trunc((dx << 9) / (distance - 19));
      const vyc = trunc((dy << 9) / (distance - 19));
      P.x[i] = P.x[i]! + trunc((tempVx + vxc) / 1024);
      P.y[i] = P.y[i]! + trunc((tempVy + vyc) / 1024);
      if (distance < 128) {
        if (P.ttl[i]! > 3) P.ttl[i] = P.ttl[i]! - 4;
        P.sat[i] = distance << 1;
      }
    }
    if (SEGMENT.custom3 === 31) P.hue[i] = P.ttl[i]! >> 2;
    else if (SEGMENT.custom3 === 0) P.hue[i] = map(distance, 20, mapMax, 0, 180);
  }
  PartSys.update();
}

// ============================================================================================
// 1D
// ============================================================================================

/*
  Particle version of Drip and Rain
*/
function mode_particleDrip(): void {
  const PartSys = getPS1D(4);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    S.hue[0] = hw_random16();
    SEGENV.aux1 = 0xffff;
  }
  PartSys.updateSystem();
  PartSys.setBounce(true);
  PartSys.setWallHardness(50);
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.setGravity(SEGMENT.custom3 >> 1);
  PartSys.setParticleSize(b(SEGMENT.check3));
  if (SEGMENT.check2) PartSys.enableParticleCollisions(true);
  else PartSys.enableParticleCollisions(false);
  S.flags[0] = S.flags[0]! & ~PF1_COLLIDE;

  if (SEGMENT.check1) {
    if (SEGMENT.custom1 === 0) PartSys.setBounce(false);
    PartSys.srcVar[0] = 5;
    PartSys.srcV[0] = -(8 + (SEGMENT.speed >> 2));
    PartSys.srcMinLife[0] = 30;
    PartSys.srcMaxLife[0] = 200;
    S.x[0] = hw_random(PartSys.maxX);
  } else {
    PartSys.srcVar[0] = 0;
    PartSys.srcV[0] = -(SEGMENT.speed >> 1);
    PartSys.srcMinLife[0] = 3000;
    PartSys.srcMaxLife[0] = 3000;
    S.x[0] = PartSys.maxX - PS_P_RADIUS_1D;
  }
  if (SEGENV.aux1 !== SEGMENT.intensity) SEGENV.aux0 = 1;
  SEGENV.aux1 = SEGMENT.intensity;

  if (SEGMENT.call % SEGENV.aux0 === 0) {
    const interval = trunc(300 / (SEGMENT.intensity + 1));
    SEGENV.aux0 = interval + hw_random(interval + 5);
    S.hue[0] = hw_random8();
    PartSys.sprayEmit(0);
  }

  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i]) {
      if ((P.flags[i]! & PF1_COLLIDE) === 0) {
        if (P.x[i]! < PS_P_RADIUS_1D << 1) {
          if (P.ttl[i]! > 120) P.ttl[i] = 120;
          if (SEGMENT.custom1 > 0) {
            P.ttl[i] = 0;
            PartSys.srcMaxLife[0] = 160;
            PartSys.srcMinLife[0] = 40;
            PartSys.srcVar[0] = 10 + (SEGMENT.custom1 >> 3);
            PartSys.srcV[0] = 0;
            S.hue[0] = P.hue[i]!;
            S.x[0] = PS_P_RADIUS_1D;
            S.flags[0] = S.flags[0]! | PF1_COLLIDE;
            for (let j = 0; j < 2 + (SEGMENT.custom1 >> 2); j++) PartSys.sprayEmit(0);
          }
        }
      } else P.ttl[i] = P.ttl[i]! - 1;
    }
    if (SEGMENT.check1) {
      if (P.hue[i]! < 245) P.hue[i] = P.hue[i]! + 8;
    }
    if (SEGMENT.speed > 200) PartSys.particleMoveUpdate(P, i);
  }
  PartSys.update();
}

/*
  Particle Version of "Bouncing Balls by Aircoookie"
  Also does rolling balls and juggle (and popcorn)
*/
function mode_particlePinball(): void {
  const PartSys = getPS1D(1, 128, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    S.flags[0] = S.flags[0]! | PF1_COLLIDE;
    S.x[0] = -1000;
    SEGENV.aux0 = 1;
    SEGENV.aux1 = 5000;
  }
  PartSys.updateSystem();
  PartSys.setGravity(map(SEGMENT.custom3, 0, 31, 0, 8));
  PartSys.setBounce(SEGMENT.custom3);
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.enableParticleCollisions(SEGMENT.check1, 255);
  PartSys.setColorByPosition(SEGMENT.check3);
  let maxParticles = max(20, trunc(SEGMENT.intensity / (1 + b(SEGMENT.check2) * (SEGMENT.custom1 >> 5))));
  if (SEGMENT.custom1 < 255) PartSys.setParticleSize(SEGMENT.custom1);
  else {
    PartSys.perParticleSize = true;
    maxParticles *= 2;
  }
  PartSys.setUsedParticles(maxParticles);

  let updateballs = false;
  const settingsSum = SEGMENT.speed + SEGMENT.intensity + b(SEGMENT.check2) + SEGMENT.custom1 + PartSys.usedParticles;
  if (SEGENV.aux1 !== settingsSum) {
    SEGENV.step = SEGMENT.call;
    updateballs = true;
    PartSys.srcMaxLife[0] = SEGMENT.custom3 ? 1000 : 0xffff;
    PartSys.srcMinLife[0] = PartSys.srcMaxLife[0]! >> 1;
  }

  if (SEGMENT.check2) {
    PartSys.setGravity(0);
    PartSys.setWallHardness(255);
    let speedsum = 0;
    for (let i = 0; i < PartSys.usedParticles; i++) {
      P.ttl[i] = 500;
      if (updateballs) {
        P.flags[i] = P.flags[i]! | PF1_COLLIDE;
        if (P.x[i] === 0) {
          P.x[i] = hw_random16(PartSys.maxX);
          P.vx[i] = hw_random16() & 0x01 ? 1 : -1;
        }
        P.hue[i] = hw_random8();
        PartSys.advSat![i] = 255;
        PartSys.advSize![i] = hw_random8();
      }
      speedsum += Math.abs(P.vx[i]!);
    }
    const avgSpeed = trunc(speedsum / PartSys.usedParticles);
    const setSpeed = 2 + (SEGMENT.speed >> 2);
    if (avgSpeed < setSpeed) {
      for (let i = 0; i < setSpeed - avgSpeed; i++) {
        const idx = hw_random16(PartSys.usedParticles);
        if (Math.abs(P.vx[idx]!) < PS_P_MAXSPEED) P.vx[idx] = P.vx[idx]! + (P.vx[idx]! >= 0 ? 1 : -1);
      }
    } else if (avgSpeed > setSpeed + 8) PartSys.applyFriction(1);
  } else {
    PartSys.setWallHardness(220);
    PartSys.srcVar[0] = SEGMENT.speed >> 3;
    const newspeed = 2 + (SEGMENT.speed >> 1) - (SEGMENT.speed >> 3);
    PartSys.srcV[0] = newspeed;
    for (let i = 0; i < PartSys.usedParticles; i++) {
      if (P.ttl[i]! < 50) P.ttl[i] = 0;
      else if (P.vx[i] === 0 && P.x[i]! < PS_P_RADIUS_1D + SEGMENT.custom1) P.ttl[i] = P.ttl[i]! - 50;
      if (updateballs) {
        if (SEGMENT.custom3 === 0) P.vx[i] = P.vx[i]! > 0 ? newspeed : -newspeed;
      }
    }
    if (SEGMENT.call > SEGENV.step) {
      const interval = 260 - SEGMENT.intensity;
      SEGENV.step += interval + hw_random16(interval);
      S.hue[0] = hw_random16();
      PartSys.srcSat[0] = 255;
      PartSys.srcSize[0] = hw_random8();
      PartSys.sprayEmit(0);
    }
  }
  SEGENV.aux1 = SEGMENT.speed + SEGMENT.intensity + b(SEGMENT.check2) + SEGMENT.custom1 + PartSys.usedParticles;
  PartSys.update();
}

/*
  Particle Replacement for original Dancing Shadows: spotlights moving back and forth
*/
const SPOT_TYPE_SOLID = 0, SPOT_TYPE_GRADIENT = 1, SPOT_TYPE_2X_GRADIENT = 2, SPOT_TYPE_2X_DOT = 3, SPOT_TYPE_3X_DOT = 4, SPOT_TYPE_4X_DOT = 5, SPOT_TYPES_COUNT = 6;
function mode_particleDancingShadows(): void {
  const PartSys = getPS1D(1);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.srcMaxLife[0] = 1000;
    PartSys.srcMinLife[0] = PartSys.srcMaxLife[0]!;
  }
  PartSys.updateSystem();
  PartSys.setMotionBlur(SEGMENT.custom1);
  if (SEGMENT.check1) PartSys.setSmearBlur(120);
  else PartSys.setSmearBlur(0);
  PartSys.setParticleSize(b(SEGMENT.check3));
  PartSys.setColorByPosition(SEGMENT.check2);
  PartSys.setUsedParticles(map(SEGMENT.intensity, 0, 255, 10, 255));

  let deadparticles = 0;
  const hueUpdate = SEGMENT.call % trunc(32 / (1 + (SEGMENT.custom2 >> 3))) === 0;
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if ((SEGMENT.call & 0x07) === 0 && P.flags[i]! & PF1_OUTOFBOUNDS) {
      if (P.vx[i]! * P.x[i]! > 0) P.ttl[i] = 0;
    }
    P.flags[i] = P.flags[i]! | PF1_PERPETUAL;
    if (hueUpdate) P.hue[i] = P.hue[i]! + 2 + (SEGMENT.custom2 >> 5);
    if (SEGENV.aux0 !== SEGMENT.speed) P.vx[i] = P.vx[i]! > 0 ? SEGMENT.speed >> 3 : -SEGMENT.speed >> 3;
    if (P.ttl[i] === 0) deadparticles++;
  }
  SEGENV.aux0 = SEGMENT.speed;

  if (deadparticles > 5 && (SEGMENT.call & 0x03) === 0) {
    const type = hw_random16(SPOT_TYPES_COUNT);
    let speed = s8(2 + hw_random16(2 + (SEGMENT.speed >> 1)) + (SEGMENT.speed >> 4));
    const width = hw_random16(1, 10);
    let ttl = 300;
    let position: number;
    if (hw_random() & 0x01) {
      position = PartSys.maxXpixel;
      speed = s8(-speed);
    } else position = -width;

    PartSys.srcV[0] = speed;
    S.hue[0] = hw_random8();
    for (let i = 0; i < width; i++) {
      if (width > 1) {
        switch (type) {
          case SPOT_TYPE_SOLID: break;
          case SPOT_TYPE_GRADIENT:
            ttl = cubicwave8(map(i, 0, width - 1, 0, 255));
            ttl = (ttl * ttl) >> 8;
            break;
          case SPOT_TYPE_2X_GRADIENT:
            ttl = cubicwave8(2 * map(i, 0, width - 1, 0, 255));
            ttl = (ttl * ttl) >> 8;
            break;
          case SPOT_TYPE_2X_DOT:
            if (i > 0) position++;
            i++;
            break;
          case SPOT_TYPE_3X_DOT:
            if (i > 0) position += 2;
            i += 2;
            break;
          case SPOT_TYPE_4X_DOT:
            if (i > 0) position += 3;
            i += 3;
            break;
        }
      }
      S.x[0] = position * PS_P_RADIUS_1D;
      const partidx = PartSys.sprayEmit(0);
      if (partidx >= 0) P.ttl[partidx] = ttl; // C writes out of bounds on -1
      position++;
    }
  }
  PartSys.update();
}

/*
  Particle Fireworks 1D replacement
*/
function mode_particleFireworks1D(): void {
  const PartSys = getPS1D(4, 150, 4, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    S.flags[0] = S.flags[0]! | PF1_CUSTOM1;
  }
  PartSys.updateSystem();
  const forcecounter = PartSys.extra;
  PartSys.setMotionBlur(SEGMENT.custom2);
  const gravity = 1 + (SEGMENT.speed >> 3);
  PartSys.setGravity(SEGMENT.speed ? gravity : 0);
  PartSys.setParticleSize(b(SEGMENT.check3));

  if (S.flags[0]! & PF1_CUSTOM1) {
    S.ttl[0] = S.ttl[0]! - 1;
    if (S.ttl[0] === 0) {
      if (hw_random8() < SEGMENT.custom1) SEGENV.aux0 = 1;
      else SEGENV.aux0 = 0;
      S.flags[0] = S.flags[0]! & ~PF1_CUSTOM1;
      S.hue[0] = hw_random16();
      PartSys.srcVar[0] = 10 * b(SEGMENT.check2);
      PartSys.srcV[0] = -10 * b(SEGMENT.check2);
      PartSys.srcMinLife[0] = 180;
      PartSys.srcMaxLife[0] = SEGMENT.check2 ? 700 : 240;
      S.x[0] = SEGENV.aux0 * PartSys.maxX;
      const speed = trunc(Math.sqrt((gravity * ((PartSys.maxX >> 2) + hw_random16(PartSys.maxX >> 1))) >> 4)) >>> 0;
      S.vx[0] = min(speed, 127);
      S.ttl[0] = 4000;
      PartSys.srcSat[0] = 30;
      S.flags[0] = S.flags[0]! & ~PF1_REVERSEGRAV;
      if (SEGENV.aux0) {
        S.flags[0] = S.flags[0]! | PF1_REVERSEGRAV;
        S.vx[0] = -S.vx[0]!;
        PartSys.srcV[0] = -PartSys.srcV[0]!;
      }
    }
  } else {
    let rocketgravity = -gravity;
    let currentspeed = S.vx[0]!;
    if (SEGENV.aux0) {
      rocketgravity = -rocketgravity;
      currentspeed = -currentspeed;
    }
    forcecounter[0] = PartSys.applyForceTo(S, 0, rocketgravity, forcecounter[0]!);
    PartSys.particleMoveUpdate(S, 0);
    PartSys.particleMoveUpdate(S, 0);
    const rocketheight = (SEGENV.aux0 ? PartSys.maxX - S.x[0]! : S.x[0]!) >>> 0;

    if (currentspeed < 0 && S.ttl[0]! > 50) S.ttl[0] = 50 - gravity;

    if (S.ttl[0]! < 2) {
      S.flags[0] = S.flags[0]! | PF1_CUSTOM1;
      // uint32 arithmetic in C
      PartSys.srcVar[0] = 5 + Math.floor((Math.imul(((PartSys.maxX >> 1) + rocketheight) >>> 0, 20 + (SEGMENT.intensity << 1)) >>> 0) / ((PartSys.maxX << 2) >>> 0));
      PartSys.srcMinLife[0] = 1200;
      PartSys.srcMaxLife[0] = 2600;
      S.ttl[0] = 100 + hw_random16(64 - (SEGMENT.speed >> 2));
      PartSys.srcSat[0] = SEGMENT.custom3 < 16 ? 10 + (SEGMENT.custom3 << 4) : 255;
      PartSys.srcSize[0] = SEGMENT.check3 ? hw_random16(SEGMENT.intensity) : 0;
      let explosionsize = (8 + (PartSys.maxXpixel >> 2) + (S.x[0]! >> (5 - 1))) >>> 0;
      explosionsize = (explosionsize + hw_random16((explosionsize * SEGMENT.intensity) >>> 8)) >>> 0;
      PartSys.setColorByAge(false);
      PartSys.setColorByPosition(false);
      for (let e = 0; e < explosionsize; e++) {
        const idx = PartSys.sprayEmit(0);
        if (idx < 0) break;
        if (SEGMENT.custom3 > 23) {
          if (SEGMENT.custom3 === 31) {
            PartSys.setColorByAge(SEGMENT.check1);
            PartSys.setColorByPosition(!SEGMENT.check1);
          } else {
            P.hue[idx] = map(Math.abs(P.vx[idx]!), 0, PartSys.srcVar[0]!, 0, 16 + hw_random16(200));
            P.hue[idx] = P.hue[idx]! + S.hue[0]!;
          }
        } else if (SEGMENT.check1) S.hue[0] = hw_random16();
      }
    }
  }
  if ((SEGMENT.call & 0x01) === 0 && (S.flags[0]! & PF1_CUSTOM1) === 0) PartSys.sprayEmit(0);
  if ((SEGMENT.call & 0x03) === 0) PartSys.applyFriction(1);
  PartSys.update();
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i]! > 20) P.ttl[i] = P.ttl[i]! - 20;
    else P.ttl[i] = 0;
  }
}

/*
  Particle based Sparkle effect
*/
function mode_particleSparkler(): void {
  let sparklersettings = 0;
  const PartSys = getPS1D(16, 128, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  PartSys.updateSystem();
  if (!SEGMENT.check2) sparklersettings |= 1; // wrap
  if (SEGMENT.check2) sparklersettings |= 2; // bounce

  let numSparklers = PartSys.numSources;
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.setParticleSize(SEGMENT.check3 ? 60 : 0);

  for (let i = 0; i < numSparklers; i++) {
    S.hue[i] = hw_random16();
    PartSys.srcVar[i] = 0;
    PartSys.srcMinLife[i] = 150 + SEGMENT.intensity;
    PartSys.srcMaxLife[i] = 250 + (SEGMENT.intensity << 1);
    const speed = SEGMENT.speed >> 1;
    if (SEGMENT.check1) PartSys.srcVar[i] = SEGMENT.intensity >> 3;
    S.vx[i] = S.vx[i]! > 0 ? speed : -speed;
    S.ttl[i] = 400;
    PartSys.srcSat[i] = SEGMENT.custom1;
    if (SEGMENT.speed === 255) S.x[i] = hw_random(PartSys.maxX);
    else PartSys.particleMoveUpdate(S, i, sparklersettings);
  }
  numSparklers = min(1 + (SEGMENT.custom3 >> 1), numSparklers);
  if (SEGENV.aux0 !== SEGMENT.custom3) {
    for (let i = 1; i < numSparklers; i++) {
      S.x[i] = (S.x[0]! + trunc(PartSys.maxX / numSparklers) * i) % PartSys.maxX;
    }
  }
  SEGENV.aux0 = SEGMENT.custom3;
  for (let i = 0; i < numSparklers; i++) {
    if (hw_random() % ((271 - SEGMENT.intensity) >> 4) === 0) PartSys.sprayEmit(i);
  }
  PartSys.update();
  const dec = 64 - (SEGMENT.intensity >> 2);
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (P.ttl[i]! > dec) P.ttl[i] = P.ttl[i]! - dec;
    else P.ttl[i] = 0;
  }
}

/*
  Particle based Hourglass, particles falling at defined intervals
*/
function mode_particleHourglass(): void {
  const positionOffset = PS_P_RADIUS_1D / 2;
  const PartSys = getPS1D(0, 255, 8, false);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setBounce(true);
    PartSys.setWallHardness(100);
  }
  PartSys.updateSystem();
  const settingTracker = PartSys.extra32; // [0]
  const direction = PartSys.extra; // [4] (bool)
  PartSys.setUsedParticles(1 + ((SEGMENT.intensity * 255) >> 8));
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.setGravity(map(SEGMENT.custom3, 0, 31, 1, 30));
  PartSys.enableParticleCollisions(true, 64);

  const colormode = SEGMENT.custom1 >> 5;
  const used = PartSys.usedParticles;

  if (SEGMENT.intensity !== settingTracker[0]) {
    settingTracker[0] = SEGMENT.intensity;
    for (let i = 0; i < used; i++) {
      P.flags[i] = P.flags[i]! | PF1_REVERSEGRAV;
      direction[4] = 0;
      SEGENV.aux1 = 1;
    }
    SEGENV.aux0 = used - 1;
  }

  for (let i = 0; i < used - 1; i++) {
    if (P.x[i]! < P.x[i + 1]! && (P.flags[i]! & PF1_FIXED) === 0 && (P.flags[i + 1]! & PF1_FIXED) === 0) {
      const t = P.x[i]!; P.x[i] = P.x[i + 1]!; P.x[i + 1] = t;
    }
  }
  const calcTargetPos = (i: number): number =>
    P.flags[i]! & PF1_REVERSEGRAV ? PartSys.maxX - i * PS_P_RADIUS_1D - positionOffset : (used - i) * PS_P_RADIUS_1D - positionOffset;

  for (let i = 0; i < used; i++) {
    if ((P.flags[i]! & PF1_FIXED) === 0 && Math.abs(P.vx[i]!) < 5) {
      const targetposition = calcTargetPos(i);
      const belowtarget = P.flags[i]! & PF1_REVERSEGRAV ? P.x[i]! > targetposition : P.x[i]! < targetposition;
      const closeToTarget = Math.abs(targetposition - P.x[i]!) < PS_P_RADIUS_1D;
      if (belowtarget || closeToTarget) {
        P.x[i] = targetposition;
        P.flags[i] = P.flags[i]! | PF1_FIXED;
      }
    }
    if (colormode === 7) PartSys.setColorByPosition(true);
    else {
      PartSys.setColorByPosition(false);
      const basehue = (SEGMENT.custom1 & 0x1f) << 3;
      switch (colormode) {
        case 0: P.hue[i] = 120; break;
        case 1: P.hue[i] = basehue; break;
        case 2:
        case 3: P.hue[i] = ((SEGMENT.custom1 & 0x1f) << 1) + (i % 3) * 74; break;
        case 4: P.hue[i] = basehue + trunc((i * 255) / used); break;
        case 5: P.hue[i] = basehue + trunc((i * 1024) / used); break;
        case 6: P.hue[i] = i + (strip.now >>> 3); break;
        default: break;
      }
    }
    if (SEGMENT.check1 && (P.flags[i]! & PF1_REVERSEGRAV) === 0) P.hue[i] = P.hue[i]! + 120;
  }

  if (SEGENV.aux1 === 1) {
    for (let i = 0; i < used; i++) {
      P.flags[i] = P.flags[i]! | PF1_COLLIDE | PF1_PERPETUAL;
      P.ttl[i] = 260;
      P.x[i] = calcTargetPos(i);
      P.flags[i] = P.flags[i]! | PF1_FIXED;
    }
  }

  if (SEGENV.aux1 === 0) {
    if (strip.now >= SEGENV.step) {
      if (SEGMENT.check3 && direction[4]) SEGENV.step = strip.now + 100;
      else SEGENV.step = strip.now + max(100, SEGMENT.speed * 100);
      if (SEGENV.aux0 < used) {
        const k = SEGENV.aux0;
        P.flags[k] = direction[4] ? P.flags[k]! | PF1_REVERSEGRAV : P.flags[k]! & ~PF1_REVERSEGRAV;
        P.flags[k] = P.flags[k]! & ~PF1_FIXED;
      } else {
        direction[4] = direction[4] ? 0 : 1;
        SEGENV.aux1 = b(SEGMENT.check2) * SEGMENT.vLength() + 100;
      }
      if (direction[4] === 0) SEGENV.aux0--;
      else SEGENV.aux0++;
    }
  } else if (SEGMENT.check2) SEGENV.aux1--;

  PartSys.update();
}

/*
  Particle based Spray effect (like a volcano, possible replacement for popcorn)
*/
function mode_particle1Dspray(): void {
  const PartSys = getPS1D(1);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setWallHardness(150);
    PartSys.setParticleSize(1);
  }
  PartSys.updateSystem();
  PartSys.setBounce(SEGMENT.check2);
  PartSys.setMotionBlur(SEGMENT.custom2);
  const gravity = -(SEGMENT.custom3 - 16);
  PartSys.setGravity(Math.abs(gravity));

  S.hue[0] = SEGMENT.aux0;
  PartSys.srcVar[0] = 20;
  PartSys.srcMinLife[0] = 200;
  PartSys.srcMaxLife[0] = 400;
  S.x[0] = map(SEGMENT.custom1, 0, 255, 0, PartSys.maxX);
  PartSys.srcV[0] = map(SEGMENT.speed, 0, 255, -127 + PartSys.srcVar[0]!, 127 - PartSys.srcVar[0]!);
  if (gravity < 0) S.flags[0] = S.flags[0]! | PF1_REVERSEGRAV;
  else S.flags[0] = S.flags[0]! & ~PF1_REVERSEGRAV;

  if (hw_random() % (1 + ((255 - SEGMENT.intensity) >> 3)) === 0) {
    PartSys.sprayEmit(0);
    SEGMENT.aux0++;
  }
  PartSys.setColorByAge(SEGMENT.check1);
  PartSys.setColorByPosition(SEGMENT.check3);
  const rg = S.flags[0]! & PF1_REVERSEGRAV;
  for (let i = 0; i < PartSys.usedParticles; i++) P.flags[i] = (P.flags[i]! & ~PF1_REVERSEGRAV) | rg;
  PartSys.update();
}

/*
  Particle based balance: particles move back and forth (1D pendent to 2D particle box)
*/
function mode_particleBalance(): void {
  let i: number;
  const PartSys = getPS1D(1, 128);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const P = PartSys.particles;
  if (SEGMENT.call === 0) PartSys.setParticleSize(1);
  PartSys.updateSystem();
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.setBounce(!SEGMENT.check2);
  PartSys.setWrap(SEGMENT.check2);
  const hardness = SEGMENT.custom1 > 0 ? map(SEGMENT.custom1, 0, 255, 50, 250) : 200;
  PartSys.enableParticleCollisions(SEGMENT.custom1, hardness);
  PartSys.setWallHardness(200);
  PartSys.setUsedParticles(map(SEGMENT.intensity, 0, 255, 10, 255));
  if (PartSys.usedParticles > SEGENV.aux1) {
    for (i = 0; i < PartSys.usedParticles; i++) {
      P.x[i] = i * PS_P_RADIUS_1D;
      P.ttl[i] = 300;
      P.flags[i] = P.flags[i]! | PF1_PERPETUAL | PF1_COLLIDE;
    }
  }
  SEGENV.aux1 = PartSys.usedParticles;

  for (i = 0; i < PartSys.usedParticles - 1; i++) {
    if (P.x[i]! > P.x[i + 1]!) {
      if (SEGMENT.check2) {
        if (P.x[i]! - P.x[i + 1]! > 3 * PS_P_RADIUS_1D) continue;
      }
      const t = P.x[i]!; P.x[i] = P.x[i + 1]!; P.x[i + 1] = t;
    }
  }

  if (SEGMENT.call % (((255 - SEGMENT.speed) >> 6) + 1) === 0) {
    let xgravity: number;
    const increment = (SEGMENT.speed >> 6) + 1;
    SEGENV.aux0 += increment;
    if (SEGMENT.check3) xgravity = perlin8(SEGENV.aux0) - 128;
    else xgravity = cos8_t(SEGENV.aux0) - 128;
    xgravity = trunc((xgravity * ((SEGMENT.custom3 + 1) << 2)) / 128);
    PartSys.applyForce(xgravity);
  }
  const randomindex = hw_random16(PartSys.usedParticles);
  P.vx[randomindex] = trunc((P.vx[randomindex]! * 200) / 255);

  if ((SEGMENT.call & 0x0f) === 0 && SEGMENT.custom3 > 4) PartSys.applyFriction(1);

  PartSys.setColorByPosition(SEGMENT.check1);
  if (!SEGMENT.check1) {
    for (i = 0; i < PartSys.usedParticles; i++) P.hue[i] = trunc((1024 * i) / PartSys.usedParticles);
  }
  PartSys.update();
}

/*
  Particle based Chase effect
*/
function mode_particleChase(): void {
  const PartSys = getPS1D(1, 191, 2, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const P = PartSys.particles, advSize = PartSys.advSize!, advSat = PartSys.advSat!;
  if (SEGMENT.call === 0) {
    SEGENV.aux0 = 0xffff;
    PartSys.extra[0] = 1;
    PartSys.extra[1] = 1;
  }
  PartSys.updateSystem();
  PartSys.setColorByPosition(SEGMENT.check3);
  PartSys.setMotionBlur(7 + (SEGMENT.custom3 << 3));
  let numParticles = (1 + map(SEGMENT.intensity, 0, 255, 0, trunc(PartSys.usedParticles / (1 + (SEGMENT.custom1 >> 5))))) >>> 0;
  numParticles = min(numParticles, PartSys.usedParticles);
  let huestep = 1 + (Math.floor((SEGMENT.custom2 << 19) / numParticles) >> 16);
  const settingssum = SEGMENT.speed + SEGMENT.intensity + SEGMENT.custom1 + SEGMENT.custom2 + b(SEGMENT.check1) + b(SEGMENT.check2) + b(SEGMENT.check3);
  if (SEGENV.aux0 !== settingssum) {
    if (SEGMENT.check1) SEGENV.step = trunc(advSize[0]! / 2) + Math.floor(PartSys.maxX / numParticles);
    else {
      SEGENV.step = Math.floor((PartSys.maxX + (PS_P_RADIUS_1D << 6)) / numParticles);
      SEGENV.step = Math.floor(SEGENV.step / PS_P_RADIUS_1D) * PS_P_RADIUS_1D;
    }
    for (let i = 0; i < PartSys.usedParticles; i++) {
      advSat[i] = 255;
      P.x[i] = Math.imul(i - 1, SEGENV.step);
      P.vx[i] = SEGMENT.speed >> 2;
      advSize[i] = SEGMENT.custom1;
      if (SEGMENT.custom2 < 255) P.hue[i] = i * huestep;
      else P.hue[i] = hw_random16();
    }
    SEGENV.aux0 = settingssum;
  }

  if (SEGMENT.check1) {
    huestep = 1 + ((max(huestep, 3) * (sin16_t(Math.imul(strip.now, 3)) + 32767)) >> 15);
  }

  for (let i = PartSys.usedParticles - 1; i >= 0; i--) {
    if (P.x[i]! > PartSys.maxX + PS_P_RADIUS_1D + advSize[i]!) {
      const nextindex = (i + 1) % PartSys.usedParticles;
      P.x[i] = P.x[nextindex]! - (SEGENV.step | 0);
      if (SEGMENT.check1) advSize[i] = max(1 + (SEGMENT.custom1 >> 1), (sin16_t(strip.now << 1) + 32767) >> 8);
      if (SEGMENT.custom2 < 255) P.hue[i] = P.hue[nextindex]! - huestep;
      else P.hue[i] = hw_random16();
    }
    P.ttl[i] = 300;
  }

  if (SEGMENT.check1) {
    const dir = PartSys.extraI8; // [0] huedir, [1] stepdir
    if (dir[1] === 0) dir[1] = 1;
    if (dir[0] === 0) dir[0] = 1;
    const perP = Math.floor(PartSys.maxX / numParticles);
    if (SEGENV.step >= advSize[0]! + PS_P_RADIUS_1D * 4 + perP) dir[1] = -1;
    else if (SEGENV.step <= (advSize[0]! >> 1) + perP) dir[1] = 1;
    if (SEGENV.aux1 > 512) dir[0] = -1;
    else if (SEGENV.aux1 < 50) dir[0] = 1;
    if (SEGMENT.call % trunc(1024 / (1 + (SEGMENT.speed >> 2))) === 0) SEGENV.aux1 += dir[0]!;
    let globalhuestep = 0;
    if (SEGMENT.call % (1 + ((sin16_t(strip.now) + 32767) >> 12)) === 0) globalhuestep = 2;
    if ((SEGMENT.call & 0x1f) === 0) SEGENV.step += dir[1]!;
    const v = 1 + (SEGMENT.speed >> 2) + (((sin16_t(strip.now >>> 1) + 32767) * (SEGMENT.speed >> 2)) >> 16);
    for (let i = 0; i < PartSys.usedParticles; i++) {
      P.hue[i] = P.hue[i]! - globalhuestep;
      P.vx[i] = v;
    }
  }
  PartSys.update();
}

/*
  Particle Fireworks Starburst replacement (smoother rendering, more settings)
*/
function mode_particleStarburst(): void {
  const PartSys = getPS1D(1, 200, 0, true);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.enableParticleCollisions(true, 200);
    S.ttl[0] = 1;
    PartSys.srcSat[0] = 0;
  }
  PartSys.updateSystem();
  PartSys.setMotionBlur(SEGMENT.custom2);
  PartSys.setGravity(b(SEGMENT.check1) * 8);

  const oldttl = S.ttl[0]!;
  S.ttl[0] = oldttl - 1;
  if (oldttl === 0) {
    const explosionsize = 4 + hw_random16(SEGMENT.intensity >> 2);
    S.hue[0] = hw_random16();
    PartSys.srcVar[0] = 10 + (explosionsize << 1);
    PartSys.srcMinLife[0] = 150;
    PartSys.srcMaxLife[0] = 300;
    S.x[0] = hw_random(PartSys.maxX);
    S.ttl[0] = 10 + hw_random16(255 - SEGMENT.speed);
    PartSys.srcSize[0] = SEGMENT.custom1;
    S.flags[0] = SEGMENT.check3 ? S.flags[0]! | PF1_COLLIDE : S.flags[0]! & ~PF1_COLLIDE;
    for (let e = 0; e < explosionsize; e++) {
      if (SEGMENT.check2) S.hue[0] = hw_random16();
      PartSys.sprayEmit(0);
    }
  }
  const advSize = PartSys.advSize!, advSat = PartSys.advSat!;
  for (let i = 0; i < PartSys.usedParticles; i++) {
    if (advSize[i]) advSize[i] = advSize[i]! - 1;
    if (advSat[i]! < 250) advSat[i] = advSat[i]! + 2 + (SEGMENT.custom3 >> 3);
  }
  if (SEGMENT.call % 5 === 0) PartSys.applyFriction(1);
  PartSys.update();
}

/*
  Particle based 1D fire
*/
function mode_particleFire1D(): void {
  const PartSys = getPS1D(5);
  if (!PartSys) return FX_FALLBACK_STATIC();
  const S = PartSys.src, P = PartSys.particles;
  if (SEGMENT.call === 0) {
    PartSys.setKillOutOfBounds(true);
    PartSys.setParticleSize(1);
  }
  PartSys.updateSystem();
  PartSys.setMotionBlur(128 + (SEGMENT.custom2 >> 1));
  PartSys.setColorByAge(true);
  let emitparticles = 1;
  let j = hw_random16();
  for (let i = 0; i < 3; i++) {
    if (S.ttl[i]! > 50) S.ttl[i] = S.ttl[i]! - 10;
    else S.ttl[i] = 100 + hw_random16(200);
  }
  for (let i = 0; i < PartSys.numSources; i++) {
    j = (j + 1) % PartSys.numSources;
    S.x[j] = 0;
    PartSys.srcVar[j] = 2 + (SEGMENT.speed >> 4);
    if (j > 2) {
      PartSys.srcMinLife[j] = 150 + SEGMENT.intensity + (j << 2);
      PartSys.srcMaxLife[j] = 200 + SEGMENT.intensity + (j << 3);
      PartSys.srcV[j] = SEGMENT.speed >> (2 + (j << 1));
      if (emitparticles) {
        emitparticles--;
        PartSys.sprayEmit(j);
      }
    } else {
      PartSys.srcMinLife[j] = S.ttl[j]! + SEGMENT.intensity;
      PartSys.srcMaxLife[j] = PartSys.srcMinLife[j]! + 50;
      PartSys.srcV[j] = SEGMENT.speed >> 2;
      if (SEGENV.call & 0x01) PartSys.sprayEmit(j);
    }
  }
  const limit = 3 + ((255 - SEGMENT.custom1) >> 1), dec = map(SEGMENT.custom1, 0, 255, 1, 3);
  for (let i = 0; i < PartSys.usedParticles; i++) {
    P.x[i] = P.x[i]! + (P.ttl[i]! >> 7);
    if (P.ttl[i]! > limit) P.ttl[i] = P.ttl[i]! - dec;
  }
  PartSys.update();
}

// ============================================================================================

const fx = (meta: string, mode: () => void, description: string, stateful?: { window?: number; warmup?: number }): EffectDef =>
  wledEffect({ meta, mode, category: 'Particles', description, ...(stateful ? { stateful } : {}) });

export const PARTICLES: EffectDef[] = [
  // 2D
  fx('PS Volcano@Speed,Intensity,Move,Bounce,Spread,AgeColor,Walls,Collide;;!;2;pal=35,sx=100,ix=190,c1=0,c2=160,c3=6,o1=1', mode_particlevolcano,
    'Glowing sparks shoot up from the bottom of the house and rain back down like an erupting volcano.'),
  fx('PS Fire@Speed,Intensity,Flame Height,Wind,Spread,Smooth,Cylinder,Turbulence;;!;2;pal=35,sx=110,c1=110,c2=50,c3=31,o1=1', mode_particlefire,
    'Realistic flames lick up the front of the house, swaying in a gentle wind.'),
  fx('PS Fireworks@Launches,Explosion Size,Fuse,Blur,Gravity,Cylinder,Ground,Fast;;!;2;pal=11,ix=50,c1=40,c2=0,c3=12', mode_particlefireworks,
    'Rockets climb up the house and burst into rings and showers of coloured sparks.',
    { warmup: 20 }), // rockets 2..8 first launch after 500*j frames and then wait ~25 s on average
  fx('PS Vortex@Rotation Speed,Particle Speed,Arms,Flip,Nozzle,Smear,Direction,Random Flip;;!;2;pal=27,c1=200,c2=0,c3=0', mode_particlevortex,
    'Spinning arms of coloured sparks spray out from the middle of the house like a pinwheel.'),
  fx('PS Fuzzy Noise@Speed,Particles,Bounce,Friction,Scale,Cylinder,Smear,Collide;;!;2;pal=64,sx=50,ix=200,c1=130,c2=30,c3=5', mode_particleperlin,
    'A swarm of tiny lights drifts and gathers into slowly shifting cloudy patches.'),
  fx('PS Ballpit@Speed,Intensity,Size,Hardness,Saturation,Cylinder,Walls,Ground;;!;2;pal=11,sx=100,ix=220,c1=70,c2=180,c3=31,o3=1', mode_particlepit,
    'Coloured balls drop from the top and bounce and pile up along the bottom of the house.',
    { warmup: 20 }), // one ball every 18 frames living 30-50 s: let the pit fill before a window starts
  fx('PS Box@!,Particles,Tilt,Hardness,Size,Random,Washing Machine,Sloshing;;!;2;pal=53,ix=50,c3=1,o1=1', mode_particlebox,
    'Coloured balls tumble around inside the house outline as if the house were being tilted.'),
  fx('PS Attractor@Mass,Particles,Size,Collide,Friction,AgeColor,Move,Swallow;;!;2;pal=9,sx=100,ix=82,c1=2,c2=0', mode_particleattractor,
    'Sparks swirl in orbits around an invisible centre of gravity in the middle of the house.'),
  fx('PS Impact@Launches,!,Force,Hardness,Blur,Cylinder,Walls,Collide;;!;2;pal=0,sx=32,ix=85,c1=70,c2=130,c3=0,o3=1', mode_particleimpact,
    'Meteors streak down the house and explode into sparks when they hit the ground.'),
  fx('PS Waterfall@Speed,Intensity,Variation,Collide,Position,Cylinder,Walls,Ground;;!;2;pal=9,sx=15,ix=200,c1=32,c2=160,o3=1', mode_particlewaterfall,
    'Streams of light pour down from the roofline and splash at the bottom like a waterfall.'),
  fx('PS Ghost Rider@Speed,Spiral,Blur,Color Cycle,Spread,AgeColor,Walls;;!;2;pal=1,sx=70,ix=0,c1=220,c2=30,c3=21,o1=1', mode_particleghostrider,
    'A bright white head wanders across the house trailing a colourful tail of sparks.'),
  fx('PS Galaxy@!,!,Size,,Color,,Starfield,Trace;;!;2;pal=59,sx=80,c1=1,c3=4', mode_particlegalaxy,
    'Stars spiral slowly into the centre of the house like a turning galaxy.'),
  // 1D
  fx('PS DripDrop@Speed,!,Splash,Blur,Gravity,Rain,PushSplash,Smooth;,!;!;1;pal=0,sx=150,ix=25,c1=220,c2=30,c3=21', mode_particleDrip,
    'Drops of light form at the end of each string, fall and splash at the start.'),
  fx('PS Pinball@Speed,!,Size,Blur,Gravity,Collide,Rolling,Position Color;,!;!;1;pal=0,ix=220,c2=0,c3=8,o1=1', mode_particlePinball,
    'Coloured balls are tossed up the strings and bounce back down, knocking into each other.'),
  fx('PS Dancing Shadows@Speed,!,Blur,Color Cycle,,Smear,Position Color,Smooth;,!;!;1;sx=100,ix=180,c1=0,c2=0', mode_particleDancingShadows,
    'Coloured spotlights of different widths glide back and forth along the lights.'),
  fx('PS Fireworks 1D@Gravity,Explosion,Firing side,Blur,Color,Colorful,Trail,Smooth;,!;!;1;c2=30,o1=1', mode_particleFireworks1D,
    'A rocket shoots along the string and bursts into a spray of coloured sparks.'),
  fx('PS Sparkler@Move,!,Saturation,Blur,Sparklers,Slide,Bounce,Large;,!;!;1;pal=0,sx=255,c1=0,c2=0,c3=6', mode_particleSparkler,
    'Bright sparks crackle along the lights like hand-held sparklers.'),
  fx('PS Hourglass@Interval,!,Color,Blur,Gravity,Colorflip,Start,Fast Reset;,!;!;1;pal=34,sx=5,ix=200,c1=140,c2=80,c3=4,o1=1,o2=1,o3=1', mode_particleHourglass,
    'Grains of light drop one by one and pile up at the start of the string like an hourglass.',
    { window: 60, warmup: 0 }), // starts full each minute (a whole cycle takes minutes, too long to replay)
  fx('PS Spray 1D@Speed(+/-),!,Position,Blur,Gravity(+/-),AgeColor,Bounce,Position Color;,!;!;1;sx=200,ix=220,c1=0,c2=0', mode_particle1Dspray,
    'A fountain of coloured sparks sprays along the lights and falls back.'),
  fx('PS 1D Balance@!,!,Hardness,Blur,Tilt,Position Color,Wrap,Random;,!;!;1;pal=18,c2=0,c3=4,o1=1', mode_particleBalance,
    'A row of coloured beads slides back and forth along the lights as if the string were tilting.'),
  fx('PS Chase@!,Density,Size,Hue,Blur,Playful,,Position Color;,!;!;1;pal=11,sx=50,c2=5,c3=0', mode_particleChase,
    'Evenly spaced coloured dots chase each other along the lights.'),
  fx('PS Starburst@Chance,Fragments,Size,Blur,Cooling,Gravity,Colorful,Push;,!;!;1;pal=52,sx=150,ix=150,c1=120,c2=0,c3=21', mode_particleStarburst,
    'White flashes pop at random spots and burst outwards into fading coloured fragments.'),
  fx('PS Fire 1D@!,!,Cooling,Blur;,!;!;1;pal=35,sx=100,ix=50,c1=80,c2=100,c3=28,o1=1,o2=1', mode_particleFire1D,
    'Flickering flames rise from the start of each string and fade as they climb.'),
];
