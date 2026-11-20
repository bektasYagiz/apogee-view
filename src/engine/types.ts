export interface TelemetryFrame {
  ts: number;
  quat: [number, number, number, number];
  lat: number;
  lon: number;
  alt: number;
  state: string;
}
