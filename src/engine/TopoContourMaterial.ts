import { Color, ShaderMaterial, Vector3 } from "three";

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
uniform vec3 uBaseLow;
uniform vec3 uBaseHigh;
uniform vec3 uRidge;
uniform vec3 uMinorLine;
uniform vec3 uMajorLine;
uniform vec3 uGridLine;
uniform vec3 uAxisLine;

varying vec3 vWorldPos;
varying vec3 vNormal;

// Distance to the nearest line in screen pixels: fwidth converts "fraction of an interval" into
// pixels, so lines keep a fixed pixel width at any range with no baked texture.
float aaLine(float pixels, float widthPx) {
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, pixels);
}

// fadeLo..fadeHi: how many intervals one pixel may span before the line thins out; denser than
// that it would only add grey haze, which is what bloated contours on distant slopes.
float contourLine(float h, float interval, float widthPx, float fadeLo, float fadeHi) {
  float f = h / interval;
  float rawFw = fwidth(f);
  float fw = max(rawFw, 1e-5);
  float line = aaLine(abs(fract(f - 0.5) - 0.5) / fw, widthPx);
  // perfectly flat ground has no isolines (otherwise the whole plane would be one at h = 0)
  return line * step(1e-6, rawFw) * (1.0 - smoothstep(fadeLo, fadeHi, fw));
}

float gridLine(vec2 p, float spacing, float widthPx) {
  vec2 q = p / spacing;
  vec2 fw = max(fwidth(q), vec2(1e-5));
  vec2 d = abs(fract(q - 0.5) - 0.5) / fw;
  float line = max(aaLine(d.x, widthPx), aaLine(d.y, widthPx));
  return line * (1.0 - smoothstep(0.12, 0.35, max(fw.x, fw.y)));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 v = toCam / max(dist, 1e-4);
  float h = vWorldPos.y + uBaseElevation;

  // relief: elevation lifts the base slightly, the sun adds a cool tint only on faces it hits
  float elev = clamp((vWorldPos.y + 250.0) / 900.0, 0.0, 1.0);
  float lit = max(dot(n, uSunDir), 0.0);
  vec3 col = mix(uBaseLow, uBaseHigh, clamp(elev * 0.55 + lit * 0.45, 0.0, 1.0));
  col += uRidge * pow(lit, 1.5) * 0.9;

  // grazing views and long range squeeze many metres of elevation into a pixel
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  // widthPx is the solid core; the 1 px smoothstep ramp brings the visible line to ~1-1.5 px
  float minor = contourLine(h, 10.0, 0.6, 0.06, 0.20)
      * smoothstep(0.10, 0.45, ndv) * (1.0 - smoothstep(500.0, 1500.0, dist));
  float major = contourLine(h, 50.0, 0.9, 0.10, 0.30)
      * smoothstep(0.04, 0.25, ndv) * (1.0 - smoothstep(1400.0, 3000.0, dist));

  // ENU ground grid: 100 m minor, 500 m major, with the launch-pad axes (x = 0, z = 0) picked out
  vec2 xz = vWorldPos.xz;
  float gridMinor = gridLine(xz, 100.0, 1.0) * (1.0 - smoothstep(600.0, 1600.0, dist));
  float gridMajor = gridLine(xz, 500.0, 1.2) * (1.0 - smoothstep(1500.0, 3200.0, dist));
  vec2 axisFw = max(fwidth(xz), vec2(1e-5));
  vec2 axisD = abs(xz) / axisFw;
  float axis = max(aaLine(axisD.x, 1.5), aaLine(axisD.y, 1.5));

  col = mix(col, uGridLine, gridMinor * 0.22);
  col = mix(col, uGridLine, gridMajor * 0.45);
  col = mix(col, uMinorLine, minor * 0.85);
  col = mix(col, uMajorLine, major * 0.40);
  col = mix(col, uAxisLine, axis * 0.35);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>

  // blend in output space so the rim matches the clear color exactly
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
        // Color converts these sRGB hex values to linear, so they render as the exact hex shades
        uBaseLow: { value: new Color(0x090d14) },
        uBaseHigh: { value: new Color(0x121a26) },
        uRidge: { value: new Color(0x1e293b) },
        uMinorLine: { value: new Color(0x1e2d42) },
        uMajorLine: { value: new Color(0x38bdf8) },
        uGridLine: { value: new Color(0x2a3a52) },
        uAxisLine: { value: new Color(0x38bdf8) },
      },
      // exact palette: tone mapping would shift these dark values and the rim against the background
      toneMapped: false,
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
