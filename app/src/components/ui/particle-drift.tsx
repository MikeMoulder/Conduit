"use client";

import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Particle drift, drawn straight onto a canvas.
 *
 * Adapted from a self contained hero page that ran this same animation inside
 * an iframe and pulled Tailwind, GSAP, an icon set and two fonts from CDNs to
 * do it. Only the canvas was ever shown, so only the canvas is kept: no
 * iframe, no network, and a transparent background so the field sits on the
 * app's own canvas colour instead of painting a second one over it.
 *
 * Two layers: characters that drift down and flicker, and faint lines between
 * characters that come close. Characters near the pointer light up in the
 * accent and reach for it. A third layer of fast rising beams was removed: it
 * pulled the eye away from the conversation. The canvas itself never
 * takes pointer events, so whatever sits on top stays clickable.
 */

export type ParticleDriftProps = {
  /** Multiplies every velocity. 0 freezes the field. */
  speed?: number;
  /** Multiplies how many characters there are. */
  density?: number;
  /** Multiplies the reach of the proximity lines. */
  length?: number;
  /** Opacity of the whole field. */
  opacity?: number;
  /** Accent as "r, g, b", used for anything near the pointer. */
  accent?: string;
  className?: string;
  style?: CSSProperties;
};

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*()".split("");
const POINTER_REACH = 180;

type Node = { x: number; y: number; vy: number; char: string };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function pick() {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

export default function ParticleDrift({
  speed = 1,
  density = 1,
  length = 1,
  opacity = 1,
  accent = "52, 211, 153",
  className,
  style,
}: ParticleDriftProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const pace = clamp(speed, 0, 3);
    const count = clamp(density, 0.25, 2.5);
    const reach = Math.round(120 * clamp(length, 0.35, 2.5));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let nodes: Node[] = [];
    const pointer = { x: -1000, y: -1000 };
    let frame = 0;

    function seed() {
      nodes = Array.from({ length: Math.max(12, Math.round(90 * count)) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vy: Math.random() * 0.4 + 0.1,
        char: pick(),
      }));
    }

    function resize() {
      if (!canvas || !ctx) return;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // Set rather than scaled, so repeated resizes do not compound.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (still) draw(false);
    }

    function draw(move: boolean) {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      ctx.lineWidth = 0.5;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < reach) {
            ctx.strokeStyle = `rgba(156, 163, 175, ${0.15 * (1 - d / reach)})`;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const n of nodes) {
        if (move) {
          n.y += n.vy * pace;
          if (n.y > height + 20) {
            n.y = -20;
            n.x = Math.random() * width;
          }
        }
        const dist = Math.hypot(pointer.x - n.x, pointer.y - n.y);
        const near = dist < POINTER_REACH;
        if (move && (near || Math.random() > 0.98)) n.char = pick();
        if (near) {
          ctx.strokeStyle = `rgba(${accent}, ${0.5 * (1 - dist / POINTER_REACH)})`;
          ctx.beginPath();
          ctx.moveTo(n.x, n.y);
          ctx.lineTo(pointer.x, pointer.y);
          ctx.stroke();
        }
        ctx.fillStyle = near ? `rgb(${accent})` : "rgba(156, 163, 175, 0.4)";
        ctx.fillText(n.char, n.x, n.y);
      }
    }

    function loop() {
      draw(true);
      frame = requestAnimationFrame(loop);
    }

    // Read from the window because the canvas ignores pointer events, which is
    // what keeps the content layered over it usable.
    function onPointerMove(event: PointerEvent) {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      if (still) draw(false);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    window.addEventListener("pointermove", onPointerMove);
    if (!still) frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [speed, density, length, accent]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: clamp(opacity, 0.05, 1),
        ...style,
      }}
    />
  );
}
