declare module 'fastnoise-lite' {
  export default class FastNoiseLite {
    constructor(seed?: number);
    static NoiseType: { OpenSimplex2: string; OpenSimplex2S: string; Cellular: string; Perlin: string; ValueCubic: string; Value: string };
    SetSeed(seed: number): void;
    SetFrequency(frequency: number): void;
    SetNoiseType(type: string): void;
    GetNoise(x: number, y: number, z?: number): number;
  }
}
