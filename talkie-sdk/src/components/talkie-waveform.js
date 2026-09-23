import { LitElement, css, html } from 'lit';

/**
 * Canvas-based waveform visualiser — ported from mockup's `startWave()`.
 *
 * Fix 5 (reduced motion): when `hasReducedMotion` is true or the system
 * prefers reduced motion, renders a static bar field instead of animating.
 */
export class TalkieWaveform extends LitElement {
  static properties = {
    enabled:         { type: Boolean, reflect: true },
    color:           { type: String, attribute: 'color' },
    hasReducedMotion:{ type: Boolean, attribute: 'has-reduced-motion' },
    _canvasWidth:    { type: Number, state: true },
    _animId:         { type: Number, state: true },
    _bars:           { type: Array, state: true },
    _velocities:     { type: Array, state: true },
    _time:           { type: Number, state: true },
    _reduced:        { type: Boolean, state: true },
    _dpr:            { type: Number, state: true },
  };

  static get styles() {
    return css`
      :host {
        display: block;
        width: 100%;
        height: var(--talkie-wave-height, 72px);
        position: relative;
      }
      canvas {
        width: 100%;
        height: 100%;
        display: block;
      }
      /* Static bar field for reduced-motion / disabled states */
      .static-bars {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        gap: calc((var(--talkie-wave-container-width, 100%) -
                    var(--talkie-wave-bar-count, 40) * var(--talkie-wave-bar-width, 4px))
                   / max(var(--talkie-wave-bar-count, 40) - 1, 1));
      }
      .static-bars span {
        width: var(--talkie-wave-bar-width, 4px);
        min-height: 4px;
        height: var(--talkie-wave-static-height, 36px);
        background: var(--talkie-wave-color, var(--talkie-state, #ff8a4c));
        border-radius: 2px;
        opacity: 0.35;
        transition: height .3s;
      }
    `;
  }

  constructor() {
    super();
    this.enabled     = false;
    this.color       = '#ff8a4c';
    this.hasReducedMotion = false;
    this._canvasWidth = 320;
    this._animId      = null;
    this._bars        = [];
    this._velocities  = [];
    this._time        = 0;
    this._reduced     = false;
    this._dpr         = 1;
  }

  connectedCallback() {
    super.connectedCallback();
    // Determine reduced motion preference initially
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    this._reduced = this.hasReducedMotion || mq.matches;

    this._setupCanvas();
    this._resizeObserver = new ResizeObserver(() => { this._setupCanvas(); });
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._stopAnim();
  }

  updated(changed) {
    if (changed.has('enabled') && this.enabled && !this._animId) {
      if (!this._reduced) this._startAnim();
      else this._renderStatic();
    }
    if (changed.has('hasReducedMotion')) {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = this.hasReducedMotion || mq.matches;
      if (this._reduced && this.enabled) {
        this._stopAnim();
        this._renderStatic();
      }
    }
    if ((changed.has('enabled') || changed.has('_reduced'))
        && !this.enabled && this._animId) {
      this._stopAnim();
    }
    if (changed.has('color') && this.enabled && !this._reduced) {
      this._drawFrame();
    }
  }

  /* ── Canvas helpers ─────────────────────────── */

  _setupCanvas() {
    const rect = this.getBoundingClientRect();
    const w = Math.max(rect.width || 320, 1);
    const h = Math.max(this.clientHeight || 72, 1);
    const dpr = window.devicePixelRatio || 1;
    this._canvasWidth = w;
    this._dpr = dpr;
    const canvas = this.shadowRoot?.querySelector('canvas');
    if (canvas) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
    }
    // Rebuild bars arrays on size change
    const N = 40;
    this._bars = Array.from({ length: N }, (_, i) => i);
    this._velocities = Array(N).fill(0.15);
    this._time = 0;
    if (this.enabled) {
      if (!this._reduced) this._startAnim();
      else this._renderStatic();
    }
  }

  _startAnim() {
    if (this._animId) return;
    const render = () => {
      if (!this.enabled || this._reduced) { this._animId = null; return; }
      this._drawFrame();
      this._animId = requestAnimationFrame(render);
    };
    this._animId = requestAnimationFrame(render);
  }

  _stopAnim() {
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
  }

  _drawFrame() {
    const canvas = this.shadowRoot?.querySelector('canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = this._canvasWidth;
    const H = this.clientHeight || 72;
    const c = this._pageColor() || this.color || '#ff8a4c';
    const N = this._bars.length;

    this._time += 0.09;

    for (let i = 0; i < N; i++) {
      const target = (.2 + .8 * Math.abs(Math.sin(this._time + i * 0.32))) * (.35 + .65 * Math.random());
      this._velocities[i] += (target - this._velocities[i]) * 0.25;
    }

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = c;
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    const step = W / (N - 1);
    for (let i = 0; i < N; i++) {
      const v = this._velocities[i];
      const h = Math.max(4, v * H * 0.92);
      const px = i * step;
      const py = (H - h) / 2;
      ctx.globalAlpha = 0.3 + 0.7 * v;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py + h);
      ctx.stroke();
    }
  }

  /**
   * A page's --talkie-wave-color, which wins over `color` as it does for the static bars.
   * The canvas can't read CSS, so this is looked up each frame and a theme change shows at once.
   */
  _pageColor() {
    return getComputedStyle(this).getPropertyValue('--talkie-wave-color').trim();
  }

  /* ── Static bar field (Fix 5) ───────────────── */

  _renderStatic() {
    // Trigger re-render via property update
    this._bars = [...this._bars];
  }

  /* ── Template ───────────────────────────────── */

  render() {
    if (this._reduced || !this.enabled) {
      return html`<div class="static-bars">${
        this._bars.map(() => html`<span></span>`)
      }</div>`;
    }
    return html`<canvas></canvas>`;
  }
}
