const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"]);
const rollKeys = new Set(["Comma", "Period"]);
/** Rodrigues rotation of v around a unit axis by ang radians. */
const rotAxis = (v, axis, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = dot(axis, v);
  const cr = cross(axis, v);
  return v.map((x, i) => x * c + cr[i] * s + axis[i] * k * (1 - c));
};

export function lookAt(eye, target, up) {
  const back = unit(eye.map((v, i) => v - target[i]));
  const right = unit(cross(up, back)),
    vertical = cross(back, right);
  return new Float32Array([
    right[0],
    vertical[0],
    back[0],
    0,
    right[1],
    vertical[1],
    back[1],
    0,
    right[2],
    vertical[2],
    back[2],
    0,
    -dot(right, eye),
    -dot(vertical, eye),
    -dot(back, eye),
    1,
  ]);
}

export function validateCameraView({ eye, target, up = "y", fov = 45 }) {
  if (
    ![eye, target].every(
      (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite),
    ) ||
    !Number.isFinite(fov) ||
    fov < 10 ||
    fov > 120
  )
    throw new Error(
      "Invalid camera view: use finite eye/target vectors, y/z up and a 10–120 degree fov.",
    );
  // up: "y"/"z" axis names (original semantics) or a finite 3-vector
  // (arbitrary roll, e.g. EGSC posetrace cameras with up ~ -Y).
  let upVector = null;
  if (Array.isArray(up)) {
    if (!(up.length === 3 && up.every(Number.isFinite)))
      throw new Error("Invalid camera view: up vector must hold 3 finite numbers.");
    const norm = Math.hypot(...up);
    if (!(norm > 1e-6))
      throw new Error("Invalid camera view: up vector must be non-zero.");
    upVector = up.map((v) => v / norm);
    const direction = eye.map((v, i) => v - target[i]);
    const dNorm = Math.hypot(...direction);
    const parallel =
      Math.abs(direction.reduce((s, v, i) => s + v * upVector[i], 0)) /
      (dNorm * 1);
    if (parallel > 0.9999)
      throw new Error("Camera up must not be parallel to the view direction.");
  } else if (! ["y", "z"].includes(up)) {
    throw new Error(
      "Invalid camera view: use finite eye/target vectors, y/z up and a 10–120 degree fov.",
    );
  }
  const distance = Math.hypot(...eye.map((v, i) => v - target[i]));
  if (!(distance > 1e-6 && Number.isFinite(distance)))
    throw new Error("Camera eye and target must be distinct finite positions.");
  return { eye: [...eye], target: [...target], up: upVector ?? up, fov };
}

export class OrbitCamera {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.keys = new Set();
    this.fast = false;
    this.enabled = true;
    this.addedTabIndex = !canvas.hasAttribute("tabindex");
    if (this.addedTabIndex) canvas.tabIndex = 0;
    this.upAxis = "y";
    this.roll = 0; // display bookkeeping; see #rollAngle for the live value
    // Reference up for the roll readout/reset: the orientation the camera
    // was restored/fitted with. Rolling measures deviation from THIS, not
    // from world up, so "reset roll" returns to the imported view's tilt.
    this.upRef = [0, 1, 0];
    // Orientation basis [rx,ry,rz, ux,uy,uz, bx,by,bz]: camera right/up/back
    // axes in world space, orthonormal, right-handed (right x up = back).
    // eye = target + back * distance. Trackball style: drags and roll rotate
    // the basis in the camera's local frame, so rolled cameras drag naturally.
    this.basis = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.bounds = { center: [0, 0, 0], radius: 1 };
    this.fit();
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    canvas.addEventListener(
      "keydown",
      (event) => {
        if (!this.enabled) return;
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.isComposing
        ) {
          this.stopMoving();
          return;
        }
        if (event.defaultPrevented) return;
        this.fast = event.shiftKey;
        if (!movementKeys.has(event.code) && !rollKeys.has(event.code)) return;
        event.preventDefault();
        // After a blur/reset, require a fresh press rather than an old key repeat.
        if (!event.repeat || this.keys.has(event.code))
          this.keys.add(event.code);
      },
      options,
    );
    canvas.addEventListener(
      "keyup",
      (event) => {
        this.keys.delete(event.code);
        this.fast = event.shiftKey;
      },
      options,
    );
    canvas.addEventListener("blur", () => this.stopMoving(), options);
    canvas.ownerDocument.defaultView.addEventListener(
      "blur",
      () => this.stopMoving(),
      options,
    );
    canvas.ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (canvas.ownerDocument.hidden) this.stopMoving();
      },
      options,
    );
    const pointers = new Map();
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), options);
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.enabled) return;
        canvas.focus();
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (!this.enabled) return;
        const old = pointers.get(e.pointerId);
        if (!old) return;
        const dx = e.clientX - old.x,
          dy = e.clientY - old.y;
        if (pointers.size === 2) {
          const other = [...pointers.entries()].find(
            ([id]) => id !== e.pointerId,
          )[1];
          const before = Math.hypot(old.x - other.x, old.y - other.y);
          const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
          if (after > 0) this.zoom(before / after);
          this.pan(dx / 2, dy / 2);
        } else if (e.buttons === 2 || e.buttons === 4 || e.shiftKey)
          this.pan(dx, dy);
        else this.orbit(dx, dy);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.onChange();
      },
      options,
    );
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(
        name,
        (e) => pointers.delete(e.pointerId),
        options,
      );
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.001));
        this.onChange();
      },
      { ...options, passive: false },
    );
  }
  #worldUp() {
    return this.upAxis === "z" ? [0, 0, 1] : [0, 1, 0];
  }
  #setBasis(back, up) {
    // back must be unit; up only needs a rough direction (re-orthogonalized).
    // If the up hint is close to the new back, rotating it ONTO the plane
    // perpendicular to back keeps the roll more faithfully than the old
    // world-axis fallback, which flipped the reconstructed up by 180° and
    // made the roll readout jump.
    const b = unit(back);
    let u = up;
    const parallel = Math.abs(dot(b, u));
    if (parallel > 0.9999) {
      const wu = this.#worldUp();
      u = Math.abs(dot(b, wu)) > 0.9 ? [1, 0, 0] : wu;
    }
    // Gram-Schmidt: project u into the back-perpendicular plane. This is
    // exact for roll preservation: the projected up differs from the true
    // rolled up only in its back component, which the basis never stores.
    const d = dot(b, u);
    u = u.map((x, i) => x - d * b[i]);
    const un = Math.hypot(...u);
    u = un < 1e-9 ? (() => {
      const wu = this.#worldUp();
      const w = Math.abs(dot(b, wu)) > 0.9 ? [1, 0, 0] : wu;
      const dd = dot(b, w);
      return w.map((x, i) => x - dd * b[i]);
    })() : u.map((x) => x / un);
    const right = unit(cross(u, b));
    const up2 = cross(b, right);
    this.basis = [...right, ...up2, ...b];
  }
  /** Rotate the basis around one of its own axes (0=right, 1=up, 2=back). */
  #rotateAroundLocal(axisIndex, angle) {
    if (!angle) return;
    const [rx, ry, rz, ux, uy, uz, bx, by, bz] = this.basis;
    let a, b, c; // the three basis columns as vectors
    if (axisIndex === 0) { a = [rx, ry, rz]; b = [ux, uy, uz]; c = [bx, by, bz]; }
    else if (axisIndex === 1) { a = [ux, uy, uz]; b = [bx, by, bz]; c = [rx, ry, rz]; }
    else { a = [bx, by, bz]; b = [rx, ry, rz]; c = [ux, uy, uz]; }
    const cos = Math.cos(angle), sin = Math.sin(angle);
    // Rodrigues around a (unit). For the orthonormal cyclic set a x b = c:
    // b' = b cos + c sin, c' = c cos − b sin (a·b = a·c = 0 kills the k(k·v) term).
    const bNew = b.map((x, i) => x * cos + c[i] * sin);
    const cNew = c.map((x, i) => x * cos - b[i] * sin);
    if (axisIndex === 0) this.basis = [...a, ...bNew, ...cNew];
    else if (axisIndex === 1) this.basis = [...cNew, ...a, ...bNew];
    else this.basis = [...bNew, ...cNew, ...a];
  }
  /** Pointer drag: rotate around local up (horizontal) and local right (vertical). */
  orbit(dx, dy) {
    // Sensitivity: 1/4 of the upstream 0.006 after user feedback.
    const k = 0.0015;
    this.#rotateAroundLocal(1, -dx * k);
    // pole guard: keep |back · worldUp| within the old pitch clamp (±~86°)
    const before = [...this.basis];
    this.#rotateAroundLocal(0, -dy * k);
    const b = [this.basis[6], this.basis[7], this.basis[8]];
    const wu = this.#worldUp();
    if (Math.abs(dot(b, wu)) > 0.9975) this.basis = before;
    this.#applyLimits();
  }
  fit(bounds = this.bounds) {
    this.stopMoving();
    this.bounds = bounds;
    this.target = [...bounds.center];
    const aspect = Math.max(
      0.1,
      this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
    );
    const halfAngle = Math.atan(Math.tan(Math.PI / 8) * Math.min(1, aspect));
    this.distance = (bounds.radius / Math.sin(halfAngle)) * 1.1;
    this.fov = Math.PI / 4;
    // default viewing angle (old yaw 0.45 / pitch 0.12)
    const yaw = 0.45, pitch = 0.12;
    const horizontal = Math.cos(pitch);
    let offset = [Math.sin(yaw) * horizontal, Math.sin(pitch), Math.cos(yaw) * horizontal];
    if (this.upAxis === "z") [offset[1], offset[2]] = [-offset[2], offset[1]];
    this.#setBasis(unit(offset), this.#worldUp());
    this.upRef = [...this.#worldUp()];
    this.roll = 0;
    this.onChange?.();
  }
  restore(view) {
    const { eye, target, up, fov } = validateCameraView(view);
    this.stopMoving();
    const offset = eye.map((v, i) => v - target[i]);
    const distance = Math.hypot(...offset);
    this.target = [...target];
    this.distance = distance;
    this.upAxis = Array.isArray(up) ? "y" : up;
    // The view's up (vector or axis) becomes the camera's actual up basis, so
    // imported orientations keep their exact roll and drag coherently after.
    const upVec = Array.isArray(up) ? up : this.#worldUp();
    this.#setBasis(unit(offset), upVec);
    this.upRef = [...upVec];
    this.roll = 0;
    this.fov = (fov * Math.PI) / 180;
    this.#applyLimits(); // ?view= imports may exceed active limits: pull back
    this.onChange?.();
  }
  /** Impose a viewing-range limit derived from user-tuned boundary views.
   *  reference: the center view; left/right/top/bottom bound the orbit
   *  direction (pan/tilt in the reference camera's own frame, so a rolled
   *  reference works); near/far bound the eye distance to the reference
   *  target (the anchor the user orbited around). All views are plain
   *  {eye, target, up, fov} camera views. Call after restore(). */
  setViewLimits({ reference, left, right, top, bottom, near, far }) {
    const center = validateCameraView(reference);
    const back0 = unit(center.eye.map((v, i) => v - center.target[i]));
    const up0 = Array.isArray(center.up) ? unit(center.up) : this.#worldUp();
    const r0 = unit(cross(up0, back0));
    const u0 = cross(back0, r0);
    const angleOf = (view) => {
      const v = validateCameraView(view);
      const b = unit(v.eye.map((x, i) => x - v.target[i]));
      return {
        pan: Math.atan2(dot(b, r0), dot(b, back0)),
        tilt: Math.atan2(dot(b, u0), dot(b, back0)),
      };
    };
    const distFromAnchor = (view) => {
      const v = validateCameraView(view);
      return Math.hypot(...v.eye.map((x, i) => x - center.target[i]));
    };
    let leash = 0;
    for (const v of [reference, left, right, top, bottom, near, far]) {
      const t = validateCameraView(v).target;
      leash = Math.max(leash, Math.hypot(...t.map((x, i) => x - center.target[i])));
    }
    this.viewLimits = {
      back0, r0, u0, anchor: [...center.target],
      panMin: angleOf(left).pan, panMax: angleOf(right).pan,
      tiltMin: angleOf(bottom).tilt, tiltMax: angleOf(top).tilt,
      dMin: distFromAnchor(near), dMax: distFromAnchor(far),
      leash: leash * 1.2 + 1e-3,
    };
    this.#applyLimits();
    this.onChange?.();
  }
  /** Clamp the current view into the active limits: direction first (rotate
   *  the basis back onto the boundary, roll preserved via the current up),
   *  then distance (slide eye+target onto the allowed shell, view angle and
   *  eye-target distance unchanged). */
  #applyLimits() {
    const L = this.viewLimits;
    if (!L) return;
    const back = [this.basis[6], this.basis[7], this.basis[8]];
    const pan = Math.atan2(dot(back, L.r0), dot(back, L.back0));
    const tilt = Math.atan2(dot(back, L.u0), dot(back, L.back0));
    const panC = Math.min(L.panMax, Math.max(L.panMin, pan));
    const tiltC = Math.min(L.tiltMax, Math.max(L.tiltMin, tilt));
    if (panC !== pan || tiltC !== tilt) {
      // rebuild back from the clamped angles: pan around u0, then -tilt
      // around r0 (sign: +tilt must move back toward +u0)
      let b = rotAxis(L.back0, L.u0, panC);
      b = unit(rotAxis(b, L.r0, -tiltC));
      const upHint = [this.basis[3], this.basis[4], this.basis[5]];
      this.#setBasis(b, upHint);
    }
    // 2. target leash: keep the look-at point near the anchor (every
    // boundary view targets it). A runaway target — huge pan drags —
    // drags the eye out of the shell and would collapse the camera
    // distance in step 3; leashing first bounds every later correction.
    // 3 passes: leash -> shell -> wall, each pass's output feeds the next.
    for (let pass = 0; pass < 3; pass++) {
      const tRel = this.target.map((v, i) => v - L.anchor[i]);
      const tD = Math.hypot(...tRel);
      if (tD > L.leash && tD > 1e-9) {
        for (let i = 0; i < 3; i++)
          this.target[i] = L.anchor[i] + (tRel[i] / tD) * L.leash;
      }
    // distance shell: adjust the CAMERA DISTANCE so the eye lands on the
    // allowed [dMin, dMax] shell around the anchor. Moving the eye along
    // its view axis (never sliding the target) keeps the look-at point
    // stable — a radial slide used to drag the target ~100 units away on
    // zoom-out, which later flipped the eye behind the scene.
    for (let pass = 0; pass < 4; pass++) {
      const [ax, ay, az] = [this.basis[6], this.basis[7], this.basis[8]];
      const eye = [
        this.target[0] + ax * this.distance,
        this.target[1] + ay * this.distance,
        this.target[2] + az * this.distance,
      ];
      const d = Math.hypot(...eye.map((v, i) => v - L.anchor[i]));
      const dC = Math.min(L.dMax, Math.max(L.dMin, d));
      if (dC === d) break;
      this.distance = Math.max(1e-6, this.distance + dC - d);
    }
    // eye angular wall: strafe (A/D), shift-drag pan and WASD translate
    // eye+target with the view direction unchanged, so only the eye's
    // bearing drifts. Rotate the eye back onto the wall and translate the
    // target with it — view direction and roll stay exactly as they are.
    {
      const [bx, by, bz] = [this.basis[6], this.basis[7], this.basis[8]];
      const eye = [
        this.target[0] + bx * this.distance,
        this.target[1] + by * this.distance,
        this.target[2] + bz * this.distance,
      ];
      const rel = eye.map((v, i) => v - L.anchor[i]);
      const d = Math.hypot(...rel);
      if (d > 1e-9) {
        const dir = rel.map((v) => v / d);
        const panE = Math.atan2(dot(dir, L.r0), dot(dir, L.back0));
        const tiltE = Math.atan2(dot(dir, L.u0), dot(dir, L.back0));
        const panEC = Math.min(L.panMax, Math.max(L.panMin, panE));
        const tiltEC = Math.min(L.tiltMax, Math.max(L.tiltMin, tiltE));
        if (panEC !== panE || tiltEC !== tiltE) {
          let v = rel;
          if (panEC !== panE) v = rotAxis(v, L.u0, panEC - panE);
          if (tiltEC !== tiltE) v = rotAxis(v, L.r0, -(tiltEC - tiltE));
          for (let i = 0; i < 3; i++)
            this.target[i] += L.anchor[i] + v[i] - eye[i];
        }
      }
    }
    } // pass loop
    // keep the exported .roll in sync with the basis after limit-driven
    // basis rebuilds (the readout is live via rollDegrees, but .roll feeds
    // view export and the demo's legacy listeners)
    this.roll = this.#rollAngle;
  }
  zoom(factor) {
    this.distance = Math.max(
      this.bounds.radius * 0.02,
      Math.min(this.bounds.radius * 100, this.distance * factor),
    );
    this.#applyLimits();
  }
  pan(dx, dy) {
    const { view } = this.snapshot(),
      scale = this.distance / Math.max(1, this.canvas.clientHeight);
    for (let i = 0; i < 3; i++)
      this.target[i] += (-dx * view[4 * i] + dy * view[4 * i + 1]) * scale;
    this.#applyLimits();
  }
  stopMoving() {
    this.keys?.clear();
    this.fast = false;
  }
  /** Live roll: signed angle from upRef to the current up around the view
   *  axis. Derived from the basis, so it never desyncs from the camera. */
  get #rollAngle() {
    const back = [this.basis[6], this.basis[7], this.basis[8]];
    const proj = (v) => {
      const d = dot(v, back);
      return v.map((x, i) => x - d * back[i]);
    };
    let u = proj([this.basis[3], this.basis[4], this.basis[5]]);
    let r = proj(this.upRef);
    const nu = Math.hypot(...u), nr = Math.hypot(...r);
    if (nu < 1e-9 || nr < 1e-9) return 0;
    u = u.map((x) => x / nu);
    r = r.map((x) => x / nr);
    const cosA = Math.max(-1, Math.min(1, dot(u, r)));
    const cr = cross(r, u);
    const sign = dot(cr, back) >= 0 ? 1 : -1;
    return sign * Math.acos(cosA);
  }
  /** Roll the camera around the view axis: rotates the up/right basis
   *  vectors themselves, so the camera's up direction follows the roll and
   *  later drags act in the rolled frame. delta in radians. */
  rotateRoll(delta) {
    if (!Number.isFinite(delta) || !delta) return;
    this.#rotateAroundLocal(2, delta);
    this.roll = this.#rollAngle;
    this.onChange?.();
  }
  /** Read-only live roll (degrees): derived from the basis on every read,
   *  so orbit/zoom/pan updates can never leave a stale value behind. */
  get rollDegrees() {
    return (this.#rollAngle * 180) / Math.PI;
  }
  /** Reset the roll: rotate back to the reference up (the imported view's
   *  own tilt), NOT to world up. */
  resetRoll() {
    const a = this.#rollAngle;
    if (a) this.rotateRoll(-a);
    this.roll = 0;
  }
  update(seconds) {
    if (!this.keys.size) return;
    if (!this.canvas.matches(":focus") || this.canvas.ownerDocument.hidden) {
      this.stopMoving();
      return;
    }
    const held = (code) => Number(this.keys.has(code));
    const rollDir = held("Comma") - held("Period");
    if (rollDir) this.rotateRoll(rollDir * seconds * (this.fast ? 1.6 : 0.6));
    this.move(
      held("KeyW") - held("KeyS"),
      held("KeyD") - held("KeyA"),
      held("KeyE") - held("KeyQ"),
      seconds,
      this.fast,
    );
  }
  move(forward, right, up, seconds, fast = false) {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return;
    const { view } = this.snapshot();
    const direction = [0, 1, 2].map(
      (axis) =>
        right * view[4 * axis] -
        forward * view[4 * axis + 2] +
        (axis === (this.upAxis === "z" ? 2 : 1) ? up : 0),
    );
    const length = Math.hypot(...direction);
    if (length < 1e-8) return;
    const speed = Math.max(
      this.bounds.radius * 0.01,
      Math.min(this.bounds.radius, this.distance),
    );
    const step = (speed * (fast ? 4 : 1) * Math.min(seconds, 0.1)) / length;
    // Translate the eye and its orbit target together, preserving the view angle.
    for (let axis = 0; axis < 3; axis++)
      this.target[axis] += direction[axis] * step;
    this.#applyLimits();
    this.onChange?.();
  }
  snapshot() {
    const [rx, ry, rz, ux, uy, uz, bx, by, bz] = this.basis;
    const eye = [
      this.target[0] + bx * this.distance,
      this.target[1] + by * this.distance,
      this.target[2] + bz * this.distance,
    ];
    // Same layout as lookAt(): rows right/up/back, column-major mat4.
    return {
      eye,
      view: new Float32Array([
        rx, ux, bx, 0,
        ry, uy, by, 0,
        rz, uz, bz, 0,
        -dot([rx, ry, rz], eye),
        -dot([ux, uy, uz], eye),
        -dot([bx, by, bz], eye),
        1,
      ]),
      near: Math.max(1e-6, this.bounds.radius * 0.0001),
      fov: this.fov,
    };
  }
  destroy() {
    this.stopMoving();
    this.events.abort();
    if (this.addedTabIndex && this.canvas.getAttribute("tabindex") === "0")
      this.canvas.removeAttribute("tabindex");
  }
}
