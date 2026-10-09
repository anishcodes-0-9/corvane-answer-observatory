"use client";

/**
 * The Answer Field: one point per expected AI answer (week × engine × question
 * × run). Height and colour show Corvane's tone in that answer; answers that
 * do not mention Corvane rest on the floor; timeouts and never-collected
 * answers are hollow rings, so missing data is visible rather than hidden.
 *
 * WebGL via three.js, loaded on the client only. Falls back to a static SVG
 * when WebGL is unavailable; renders a single still frame when the user
 * prefers reduced motion; pauses when off-screen or hidden; disposes all GPU
 * resources on unmount.
 */
import { useEffect, useRef, useState } from "react";

export type FieldPoint = { week: number; engine: number; prompt: number; run: number; state: string };

const STYLE: Record<string, { y: number; color: string; size: number; ring: number; alpha: number }> = {
  recommended: { y: 1.6, color: "#ff5b2e", size: 10, ring: 0, alpha: 1 },
  neutral: { y: 0.8, color: "#c9c4b8", size: 6.5, ring: 0, alpha: 0.85 },
  negative: { y: 0.42, color: "#d49a4a", size: 6.5, ring: 0, alpha: 0.9 },
  not_recommended: { y: 0.1, color: "#c4503c", size: 7, ring: 0, alpha: 0.95 },
  absent: { y: 0, color: "#4a4943", size: 3.6, ring: 0, alpha: 0.7 },
  error: { y: 0, color: "#e3c77d", size: 8, ring: 1, alpha: 0.9 },
  missing: { y: 0, color: "#6a675f", size: 6, ring: 1, alpha: 0.45 },
};

/** Spacing between week columns, engine lanes and question rows (world units). */
const COL = 1.5;
const LANE = 0.36;
const ROW = 0.15;

function layout(p: FieldPoint, weeks: number, prompts: number) {
  const colX = (p.week - (weeks + 1) / 2) * COL;
  const x = colX + (p.engine - 1) * LANE + (p.run === 1 ? -0.07 : 0.07);
  const z = (p.prompt - (prompts - 1) / 2) * ROW;
  return { x, z };
}

/** Must match the CSS breakpoint where the field leaves the headline and gets its own band. */
const BAND_QUERY = "(max-width: 1080px)";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function AnswerField({ points, weeks, prompts, partialLabel }: { points: FieldPoint[]; weeks: number[]; prompts: number; partialLabel: { week: number; engine: number; text: string } | null }) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Array<HTMLSpanElement | null>>([]);
  const gapLabel = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<"pending" | "webgl" | "fallback">("pending");
  const [band, setBand] = useState(false);

  useEffect(() => {
    setMode(hasWebGL() ? "webgl" : "fallback");
    const mq = window.matchMedia(BAND_QUERY);
    const sync = () => setBand(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (mode !== "webgl" || !host.current) return;
    const el = host.current;
    let disposed = false;
    let raf = 0;
    let cleanup = () => {};

    import("three").then((THREE) => {
      if (disposed) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);
      renderer.domElement.setAttribute("aria-hidden", "true");

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      const group = new THREE.Group();
      scene.add(group);

      const n = points.length;
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const ring = new Float32Array(n);
      const alpha = new Float32Array(n);
      const phase = new Float32Array(n);
      const stems: number[] = [];
      const c = new THREE.Color();
      points.forEach((p, i) => {
        const s = STYLE[p.state] ?? STYLE.absent!;
        const { x, z } = layout(p, weeks.length, prompts);
        pos.set([x, s.y, z], i * 3);
        c.set(s.color);
        col.set([c.r, c.g, c.b], i * 3);
        size[i] = s.size;
        ring[i] = s.ring;
        alpha[i] = s.alpha;
        phase[i] = (i * 2.399) % (Math.PI * 2);
        if (s.y > 0.05) stems.push(x, 0, z, x, s.y, z);
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
      geo.setAttribute("ring", new THREE.BufferAttribute(ring, 1));
      geo.setAttribute("alpha", new THREE.BufferAttribute(alpha, 1));
      geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uMotion: { value: reduced ? 0 : 1 } },
        vertexShader: `
          attribute vec3 color; attribute float size; attribute float ring; attribute float alpha; attribute float phase;
          uniform float uTime; uniform float uScale; uniform float uMotion;
          varying vec3 vColor; varying float vRing; varying float vAlpha;
          void main() {
            vec3 p = position;
            p.y += uMotion * step(0.05, p.y) * 0.035 * sin(uTime * 0.9 + phase);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = size * uScale * (17.0 / -mv.z);
            vColor = color; vRing = ring; vAlpha = alpha;
          }`,
        fragmentShader: `
          varying vec3 vColor; varying float vRing; varying float vAlpha;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float disc = 1.0 - smoothstep(0.78, 1.0, d);
            float annulus = smoothstep(0.55, 0.68, d) * (1.0 - smoothstep(0.86, 1.0, d));
            float a = mix(disc, annulus, vRing) * vAlpha;
            if (a < 0.02) discard;
            gl_FragColor = vec4(vColor, a);
          }`,
      });
      const cloud = new THREE.Points(geo, mat);
      group.add(cloud);

      const stemGeo = new THREE.BufferGeometry();
      stemGeo.setAttribute("position", new THREE.Float32BufferAttribute(stems, 3));
      const stemMat = new THREE.LineBasicMaterial({ color: 0x8e8a80, transparent: true, opacity: 0.2 });
      group.add(new THREE.LineSegments(stemGeo, stemMat));

      // Floor plates under each week column.
      const floor: number[] = [];
      const depth = (prompts - 1) * ROW * 0.5 + 0.14;
      weeks.forEach((_, wi) => {
        const cx = (wi + 1 - (weeks.length + 1) / 2) * COL;
        const w = LANE + 0.24;
        floor.push(cx - w, -0.02, -depth, cx + w, -0.02, -depth, cx + w, -0.02, -depth, cx + w, -0.02, depth,
          cx + w, -0.02, depth, cx - w, -0.02, depth, cx - w, -0.02, depth, cx - w, -0.02, -depth);
      });
      const floorGeo = new THREE.BufferGeometry();
      floorGeo.setAttribute("position", new THREE.Float32BufferAttribute(floor, 3));
      const floorMat = new THREE.LineBasicMaterial({ color: 0x45463f, transparent: true, opacity: 0.8 });
      group.add(new THREE.LineSegments(floorGeo, floorMat));

      const v = new THREE.Vector3();
      const placeLabels = (w: number, h: number) => {
        weeks.forEach((_, wi) => {
          const span = labels.current[wi];
          if (!span) return;
          v.set((wi + 1 - (weeks.length + 1) / 2) * COL, -0.05, depth + 0.3);
          group.localToWorld(v);
          v.project(camera);
          span.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, 0)`;
          span.style.opacity = v.z < 1 ? "1" : "0";
        });
        if (gapLabel.current && partialLabel) {
          const wi = weeks.indexOf(partialLabel.week);
          // Band layout: centre the (wrapped) note over the whole week column, clear of the tallest points.
          const band = window.matchMedia(BAND_QUERY).matches;
          v.set((wi + 1 - (weeks.length + 1) / 2) * COL + (band ? 0 : (partialLabel.engine - 1) * LANE), band ? 2.45 : 2.15, 0);
          group.localToWorld(v);
          v.project(camera);
          gapLabel.current.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
        }
      };

      const resize = () => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = `${w}px`;
        renderer.domElement.style.height = `${h}px`;
        camera.aspect = w / h;
        // Wide: the field sits behind and right of the headline. Band (narrow
        // layouts): the field has its own full-width row, so frame the six
        // columns (~9 units wide plus labels) to fill it, centred.
        const wide = !window.matchMedia(BAND_QUERY).matches && w / h > 1.25;
        camera.fov = wide ? 26 : 30;
        camera.position.set(0, wide ? 4.2 : 3.4, wide ? 21 : Math.max(10.5, 10.6 / (2 * Math.tan((15 * Math.PI) / 180) * (w / h))));
        camera.lookAt(0, 0.4, 0);
        camera.updateProjectionMatrix();
        // Wide screens: the field sits right of the headline. Narrow: centred, above the fold copy.
        group.position.x = wide ? 3.3 : 0;
        group.position.y = wide ? 0.2 : -0.3;
        // Smaller points in the narrow band so neighbouring answers stay distinguishable.
        mat.uniforms.uScale!.value = Math.min(window.devicePixelRatio, 2) * (wide ? 1 : 0.7);
        renderer.render(scene, camera);
        placeLabels(w, h);
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      let visible = true;
      const io = new IntersectionObserver(([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible && !reduced) loop();
      });
      io.observe(el);

      const start = performance.now();
      const frame = () => {
        const t = (performance.now() - start) / 1000;
        mat.uniforms.uTime!.value = t;
        group.rotation.y = -0.26 + Math.sin(t * 0.07) * 0.07;
        group.rotation.x = 0.02 * Math.sin(t * 0.05);
        renderer.render(scene, camera);
        placeLabels(el.clientWidth, el.clientHeight);
      };
      const loop = () => {
        cancelAnimationFrame(raf);
        const tick = () => {
          if (!visible || document.hidden || disposed) return;
          frame();
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      };
      group.rotation.y = -0.26;
      if (reduced) frame();
      else loop();
      const onVis = () => !document.hidden && !reduced && loop();
      document.addEventListener("visibilitychange", onVis);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        [geo, stemGeo, floorGeo].forEach((g) => g.dispose());
        [mat, stemMat, floorMat].forEach((m) => m.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [mode, points, weeks, prompts, partialLabel]);

  return (
    <div className="hero-field" aria-hidden="true" data-mode={mode}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {mode === "webgl" && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {weeks.map((w, i) => (
            <span key={w} ref={(node) => { labels.current[i] = node; }} className="eyebrow field-week-label" style={{ position: "absolute", left: 0, top: 0, opacity: 0, whiteSpace: "nowrap" }}>
              Week {w}
            </span>
          ))}
          {partialLabel && (
            <span ref={gapLabel} className="eyebrow field-gap-label" style={{ position: "absolute", left: 0, top: 0, color: "var(--sand)" }}>
              {partialLabel.text}
            </span>
          )}
        </div>
      )}
      {mode === "fallback" && <FallbackField points={points} weeks={weeks} prompts={prompts} band={band} />}
    </div>
  );
}

function FallbackField({ points, weeks, prompts, band }: { points: FieldPoint[]; weeks: number[]; prompts: number; band: boolean }) {
  // Wide: drawn in the right part of the hero, clear of the headline column.
  // Band: its own full-width row, centred and spread out so weeks stay legible.
  const g = band
    ? { W: 640, H: 300, cx: 320, sx: 64, sz: 8, base: 0.7, sy: 105, dz: 16, label: 20 }
    : { W: 1000, H: 420, cx: 700, sx: 46, sz: 10, base: 0.7, sy: 120, dz: 22, label: 12 };
  const floorY = g.H * g.base;
  return (
    <svg viewBox={`0 0 ${g.W} ${g.H}`} preserveAspectRatio={band ? "xMidYMid meet" : "xMaxYMid meet"} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      {points.map((p, i) => {
        const s = STYLE[p.state] ?? STYLE.absent!;
        const { x, z } = layout(p, weeks.length, prompts);
        const cx = g.cx + x * g.sx + z * g.sz;
        const cy = floorY - s.y * g.sy - z * g.dz;
        return s.ring ? (
          <circle key={i} cx={cx} cy={cy} r={s.size / 3} fill="none" stroke={s.color} strokeOpacity={s.alpha} />
        ) : (
          <circle key={i} cx={cx} cy={cy} r={s.size / 3.4} fill={s.color} fillOpacity={s.alpha} />
        );
      })}
      {weeks.map((w, wi) => (
        <text key={w} x={g.cx + (wi + 1 - (weeks.length + 1) / 2) * COL * g.sx} y={floorY + 52} textAnchor="middle" fill="#8e8a80" style={{ font: `500 ${g.label}px var(--mono)`, letterSpacing: "0.08em" }}>
          WEEK {w}
        </text>
      ))}
    </svg>
  );
}
