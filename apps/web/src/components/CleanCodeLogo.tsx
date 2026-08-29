import { useEffect, useId, useRef } from "react";
import "./CleanCodeLogo.css";

export type CleanCodeLogoStatus = "thinking" | "streaming" | "idle";

interface CleanCodeLogoProps {
  size?: number;
  status?: CleanCodeLogoStatus;
  className?: string;
}

const SPINES = [
  { angle: 0, maxLen: 23 },
  { angle: 22.5, maxLen: 28 },
  { angle: 45, maxLen: 17 },
  { angle: 67.5, maxLen: 26 },
  { angle: 90, maxLen: 18 },
  { angle: 112.5, maxLen: 29 },
  { angle: 135, maxLen: 20 },
  { angle: 157.5, maxLen: 27 },
  { angle: 180, maxLen: 16 },
  { angle: 202.5, maxLen: 30 },
  { angle: 225, maxLen: 19 },
  { angle: 247.5, maxLen: 25 },
  { angle: 270, maxLen: 17 },
  { angle: 292.5, maxLen: 28 },
  { angle: 315, maxLen: 21 },
  { angle: 337.5, maxLen: 27 },
];

const R_INNER = 20;
const MIN_DUNK_LENGTH = 3.5;

const THINKING_GAZES = [
  { x: -2.4, y: -2.4 },
  { x: 0.0, y: 0.0 },
  { x: 2.4, y: -2.4 },
  { x: 0.0, y: -3.0 },
];

function circularDistance(a: number, b: number) {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

function bellCurve(distance: number, width: number) {
  if (distance >= width) return 0;
  return 0.5 * (1 + Math.cos((distance / width) * Math.PI));
}

export function CleanCodeLogo({
  size = 24,
  status = "idle",
  className,
}: CleanCodeLogoProps) {
  const instanceId = useId();
  const maskId = `${instanceId.replace(/:/g, "")}-clean-code-eyes`;
  const bodyRef = useRef<SVGGElement | null>(null);
  const spineRefs = useRef<(SVGLineElement | null)[]>([]);
  const leftEyeRef = useRef<SVGRectElement | null>(null);
  const rightEyeRef = useRef<SVGRectElement | null>(null);
  const leftHighlightRef = useRef<SVGCircleElement | null>(null);
  const rightHighlightRef = useRef<SVGCircleElement | null>(null);
  const gazeRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const lengthsRef = useRef<number[]>(SPINES.map((s) => s.maxLen));

  useEffect(() => {
    const bodyEl = bodyRef.current;
    const leftEye = leftEyeRef.current;
    const rightEye = rightEyeRef.current;
    const leftHl = leftHighlightRef.current;
    const rightHl = rightHighlightRef.current;
    const spines = spineRefs.current;
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf: number | null = null;
    let blinkTimeout: number | null = null;
    let blinkRaf: number | null = null;
    let cancelled = false;

    function setSpineFull() {
      spines.forEach((line, i) => {
        if (!line) return;
        const spine = SPINES[i];
        const rad = (spine.angle * Math.PI) / 180;
        const x1 = 50 + R_INNER * Math.cos(rad);
        const y1 = 50 + R_INNER * Math.sin(rad);
        const x2 = 50 + (R_INNER + spine.maxLen) * Math.cos(rad);
        const y2 = 50 + (R_INNER + spine.maxLen) * Math.sin(rad);
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
      });
    }

    function applyGaze(gx: number, gy: number) {
      if (leftEye) {
        leftEye.setAttribute("x", String(38.5 + gx));
        leftEye.setAttribute("y", String(44 + gy));
      }
      if (rightEye) {
        rightEye.setAttribute("x", String(53.5 + gx));
        rightEye.setAttribute("y", String(44 + gy));
      }
      if (leftHl) {
        leftHl.setAttribute("cx", String(41.5 + gx * 0.8));
        leftHl.setAttribute("cy", String(46 + gy * 0.8));
      }
      if (rightHl) {
        rightHl.setAttribute("cx", String(56.5 + gx * 0.8));
        rightHl.setAttribute("cy", String(46 + gy * 0.8));
      }
    }

    function setStatic(scale: number, gx: number, gy: number) {
      if (bodyEl) bodyEl.style.transform = `scale(${scale})`;
      scaleRef.current = scale;
      gazeRef.current.x = gx;
      gazeRef.current.y = gy;
      applyGaze(gx, gy);
      setSpineFull();
      lengthsRef.current = SPINES.map((s) => s.maxLen);
    }

    if (prefersReduced) {
      if (status === "thinking") {
        setStatic(1, THINKING_GAZES[0].x, THINKING_GAZES[0].y);
      } else if (status === "streaming") {
        setStatic(1, 3.2, 3.4);
      } else {
        setStatic(1, 0, 0);
      }
      return;
    }

    if (status === "idle") {
      setStatic(1, 0, 0);
      const delays = [3100, 3800, 3500, 4000, 3300];
      let delayIndex = 0;

      function scheduleBlink() {
        const delay = delays[delayIndex % delays.length];
        delayIndex += 1;
        const jitter = (Math.random() - 0.5) * 200;
        blinkTimeout = window.setTimeout(() => {
          const start = performance.now();
          const duration = 130 + Math.random() * 40;
          function blinkFrame(now: number) {
            if (cancelled) return;
            const elapsed = now - start;
            const p = Math.min(elapsed / duration, 1);
            let h: number;
            if (p < 0.5) h = 9.5 - (9.5 - 1.5) * (p * 2);
            else h = 1.5 + (9.5 - 1.5) * ((p - 0.5) * 2);
            const cy = 44 + 9.5 / 2;
            const y = cy - h / 2;
            const rx = Math.min(4.75, h / 2);
            if (leftEye) {
              leftEye.setAttribute("height", String(h));
              leftEye.setAttribute("y", String(y));
              leftEye.setAttribute("rx", String(rx));
            }
            if (rightEye) {
              rightEye.setAttribute("height", String(h));
              rightEye.setAttribute("y", String(y));
              rightEye.setAttribute("rx", String(rx));
            }
            if (p < 1) blinkRaf = requestAnimationFrame(blinkFrame);
            else {
              if (leftEye) {
                leftEye.setAttribute("height", "9.5");
                leftEye.setAttribute("y", "44");
                leftEye.setAttribute("rx", "4.75");
              }
              if (rightEye) {
                rightEye.setAttribute("height", "9.5");
                rightEye.setAttribute("y", "44");
                rightEye.setAttribute("rx", "4.75");
              }
              scheduleBlink();
            }
          }
          blinkRaf = requestAnimationFrame(blinkFrame);
        }, Math.max(1200, delay + jitter));
      }

      scheduleBlink();
      return () => {
        cancelled = true;
        if (blinkTimeout !== null) window.clearTimeout(blinkTimeout);
        if (blinkRaf !== null) cancelAnimationFrame(blinkRaf);
      };
    }

    const start = performance.now();

    function frame(now: number) {
      if (cancelled) return;
      const elapsed = now - start;

      let targetGx = 0;
      let targetGy = 0;
      if (status === "thinking") {
        const total = 4800;
        const phase = 1200;
        const hold = 700;
        const trans = 500;
        const t = elapsed % total;
        const idx = Math.floor(t / phase);
        const pt = t % phase;
        if (pt < hold) {
          targetGx = THINKING_GAZES[idx].x;
          targetGy = THINKING_GAZES[idx].y;
        } else {
          const p = (pt - hold) / trans;
          const eased = 0.5 * (1 - Math.cos(p * Math.PI));
          const cur = THINKING_GAZES[idx];
          const nxt = THINKING_GAZES[(idx + 1) % THINKING_GAZES.length];
          targetGx = cur.x + (nxt.x - cur.x) * eased;
          targetGy = cur.y + (nxt.y - cur.y) * eased;
        }
      } else if (status === "streaming") {
        const saccade = Math.sin(elapsed / 120) * 0.6;
        targetGx = 3.2 + saccade;
        targetGy = 3.4;
      }

      gazeRef.current.x += (targetGx - gazeRef.current.x) * 0.1;
      gazeRef.current.y += (targetGy - gazeRef.current.y) * 0.1;
      applyGaze(gazeRef.current.x, gazeRef.current.y);

      let targetScale = 1;
      if (status === "thinking") {
        const cycle = 1200;
        const pp = (elapsed % (cycle / 2)) / (cycle / 2);
        const pf = (Math.sin(pp * Math.PI * 2 - Math.PI / 2) + 1) / 2;
        targetScale = 0.92 + pf * 0.16;
      } else if (status === "streaming") {
        const cycle = 1000;
        const pp = (elapsed % cycle) / cycle;
        const pf = (Math.sin(pp * Math.PI * 2 - Math.PI / 2) + 1) / 2;
        targetScale = 0.98 + pf * 0.05;
      }
      scaleRef.current += (targetScale - scaleRef.current) * 0.15;
      if (bodyEl) bodyEl.style.transform = `scale(${scaleRef.current})`;

      spines.forEach((line, i) => {
        if (!line) return;
        const spine = SPINES[i];
        let targetLen = spine.maxLen;
        if (status === "thinking") {
          const progress = (elapsed % 1200) / 1200;
          const w1 = progress;
          const w2 = (w1 + 0.5) % 1;
          const pos = i / SPINES.length;
          const d1 = circularDistance(pos, w1);
          const d2 = circularDistance(pos, w2);
          const dip1 = bellCurve(d1, 0.22);
          const dip2 = bellCurve(d2, 0.22);
          const dip = Math.max(dip1, dip2);
          const f = 1 - dip;
          targetLen = MIN_DUNK_LENGTH + (spine.maxLen - MIN_DUNK_LENGTH) * f;
        } else if (status === "streaming") {
          const ripple = Math.sin(elapsed / 300 + i * 0.6);
          targetLen = spine.maxLen * (0.97 + ripple * 0.03);
        }
        lengthsRef.current[i] += (targetLen - lengthsRef.current[i]) * 0.2;
        const len = lengthsRef.current[i];
        const rad = (spine.angle * Math.PI) / 180;
        const x1 = 50 + R_INNER * Math.cos(rad);
        const y1 = 50 + R_INNER * Math.sin(rad);
        const x2 = 50 + (R_INNER + len) * Math.cos(rad);
        const y2 = 50 + (R_INNER + len) * Math.sin(rad);
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
      });

      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (blinkTimeout !== null) window.clearTimeout(blinkTimeout);
      if (blinkRaf !== null) cancelAnimationFrame(blinkRaf);
    };
  }, [status]);

  const cls = `clean-code-logo clean-code-logo--${status}${className ? ` ${className}` : ""}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cls}
      role="img"
      aria-label="Clean Code"
      style={{ color: "inherit" }}
    >
      <defs>
        <mask id={maskId}>
          <rect width="100" height="100" fill="white" />
          <rect
            ref={leftEyeRef}
            x={38.5}
            y={44}
            width={9.5}
            height={9.5}
            rx={4.75}
            fill="black"
          />
          <rect
            ref={rightEyeRef}
            x={53.5}
            y={44}
            width={9.5}
            height={9.5}
            rx={4.75}
            fill="black"
          />
        </mask>
      </defs>
      <g ref={bodyRef} className="clean-code-logo__body">
        {SPINES.map((spine, index) => {
          const rad = (spine.angle * Math.PI) / 180;
          const x1 = 50 + R_INNER * Math.cos(rad);
          const y1 = 50 + R_INNER * Math.sin(rad);
          const x2 = 50 + (R_INNER + spine.maxLen) * Math.cos(rad);
          const y2 = 50 + (R_INNER + spine.maxLen) * Math.sin(rad);
          return (
            <line
              key={index}
              ref={(el) => {
                spineRefs.current[index] = el;
              }}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeWidth={4.8}
              strokeLinecap="round"
              stroke="currentColor"
              className="clean-code-logo__spine"
            />
          );
        })}
        <circle cx={50} cy={50} r={23} fill="currentColor" mask={`url(#${maskId})`} />
        <circle
          ref={leftHighlightRef}
          cx={41.5}
          cy={46}
          r={1.5}
          fill="white"
          opacity={0.9}
        />
        <circle
          ref={rightHighlightRef}
          cx={56.5}
          cy={46}
          r={1.5}
          fill="white"
          opacity={0.9}
        />
      </g>
    </svg>
  );
}
