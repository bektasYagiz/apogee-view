import { ShaderMaterial, Vector3 } from "three";

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform float uBaseElevation;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec3 uBgColor;

varying vec3 vWorldPos;
varying vec3 vNormal;

// fwidth turns distance-to-isoline (in contour units) into screen pixels,
// so lines stay a constant pixel width at any zoom with no baked texture.
float contourLine(float h, float interval, float widthPx) {
  float f = h / interval;
  float fw = fwidth(f);
  float px = abs(fract(f - 0.5) - 0.5) / max(fw, 1e-6);
  float line = 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, px);
  // flat ground has no isolines; far-field lines fade out before they crowd into moire
  return line * step(1e-6, fw) * (1.0 - smoothstep(0.15, 0.4, fw));
}

void main() {
  vec3 n = normalize(vNormal);
  float h = vWorldPos.y + uBaseElevation;

  float t = clamp((vWorldPos.y + 150.0) / 600.0, 0.0, 1.0);
  vec3 base = mix(vec3(0.030, 0.040, 0.055), vec3(0.150, 0.180, 0.220), t);
  float diffuse = max(dot(n, uSunDir), 0.0);
  vec3 col = base * (0.35 + 0.75 * diffuse);

  col = mix(col, vec3(0.28, 0.38, 0.46), contourLine(h, 10.0, 1.0) * 0.45);
  col = mix(col, vec3(0.55, 0.68, 0.78), contourLine(h, 50.0, 2.0) * 0.8);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // blend after tone mapping so the rim matches the untonemapped clear color exactly
  float fade = smoothstep(uFadeStart, uFadeEnd, length(vWorldPos.xz));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uBgColor, fade);
}
`;

export class TopoContourMaterial extends ShaderMaterial {
  constructor(fadeStart: number, fadeEnd: number, bgHex: number, sunDir: Vector3) {
    super({
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: { value: sunDir.clone().normalize() },
        uBaseElevation: { value: 0 },
        uFadeStart: { value: fadeStart },
        uFadeEnd: { value: fadeEnd },
        // sRGB components: mixed after colorspace conversion
        uBgColor: {
          value: new Vector3(((bgHex >> 16) & 255) / 255, ((bgHex >> 8) & 255) / 255, (bgHex & 255) / 255),
        },
      },
      // keeps the pad and nadir marker from z-fighting the ground at y = 0
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  set baseElevation(m: number) {
    this.uniforms.uBaseElevation.value = m;
  }
}
