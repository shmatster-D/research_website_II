/* ---------------------------------------------------------------
   Real-time fluid simulation (stable-fluids / Navier-Stokes),
   rendered as a rising violet smoke behind the page content.
   WebGL2 required; falls back to the plain CSS gradient body
   background (already in place) when unsupported or when the
   user has requested reduced motion.
--------------------------------------------------------------- */
(function(){
  "use strict";
  var canvas = document.getElementById('fluid-canvas');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion){ canvas.remove(); return; }

  var gl = canvas.getContext('webgl2', { alpha:true, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:false, premultipliedAlpha:false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')){ canvas.remove(); return; }
  gl.getExtension('OES_texture_float_linear');

  // ---- tunables ----
  var SIM_RESOLUTION = 128;
  var DYE_RESOLUTION = 512;
  var PRESSURE_ITERATIONS = 20;
  var VELOCITY_DISSIPATION = 0.4;    // per-second decay
  var DENSITY_DISSIPATION = 0.085;   // per-second decay (dye lingers ~12s so plumes have time to climb higher)
  var CURL_STRENGTH = 10;
  var BUOYANCY = 0.075;              // upward accel scaled by local (clamped) density — kept small so smoke drifts, not rockets
  var AMBIENT_RISE = 0.012;          // tiny constant upward drift so only denser plumes really climb
  var VELOCITY_SPLAT_RADIUS = 0.03;
  var DYE_SPLAT_RADIUS = 0.06;

  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
  }
  resize();
  window.addEventListener('resize', resize);

  function getRes(resolution){
    var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    var min = Math.round(resolution);
    var max = Math.round(resolution * aspect);
    return (gl.drawingBufferWidth > gl.drawingBufferHeight) ? { width:max, height:min } : { width:min, height:max };
  }

  function createTexture(w, h, internalFormat, format, type){
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    return texture;
  }

  function createFBO(w, h, internalFormat, format, type){
    var texture = createTexture(w, h, internalFormat, format, type);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture:texture, fbo:fbo, width:w, height:h,
      attach:function(id){ gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type){
    var a = createFBO(w, h, internalFormat, format, type);
    var b = createFBO(w, h, internalFormat, format, type);
    return {
      width:w, height:h,
      get read(){ return a; }, set read(v){ a = v; },
      get write(){ return b; }, set write(v){ b = v; },
      swap:function(){ var t = a; a = b; b = t; }
    };
  }

  function compile(type, source){
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createProgram(vsSource, fsSource){
    var program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
    var uniforms = {};
    var count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++){
      var info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return {
      uniforms:uniforms,
      bind:function(){ gl.useProgram(program); }
    };
  }

  // Fullscreen quad via a real vertex buffer (more portable across drivers
  // than an attributeless gl_VertexID triangle trick).
  var quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  var quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit(target){
    gl.bindVertexArray(quadVAO);
    if (target == null){
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---- shaders ----
  var baseVertexShader = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 aPosition;
    out vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  var advectionShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv;
    out vec4 fragColor;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform float dt;
    uniform float dissipation;
    uniform float clampMax;
    uniform float riseBias;
    void main () {
      vec2 vel = texture(uVelocity, vUv).xy + vec2(0.0, riseBias);
      vec2 coord = vUv - dt * vel;
      vec4 result = texture(uSource, coord);
      float decay = 1.0 + dissipation * dt;
      fragColor = clamp(result / decay, -clampMax, clampMax);
    }`;

  var divergenceShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 fragColor;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).x;
      float R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y;
      float B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;
      if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;
      if (vB.y < 0.0) B = -C.y;
      float div = 0.5 * (R - L + T - B);
      fragColor = vec4(clamp(div, -20.0, 20.0), 0.0, 0.0, 1.0);
    }`;

  var curlShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 fragColor;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).y;
      float R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x;
      float B = texture(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }`;

  var vorticityShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 fragColor;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curlStrength;
    uniform float dt;
    void main () {
      float L = texture(uCurl, vL).x;
      float R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x;
      float B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curlStrength * C;
      force.y *= -1.0;
      vec2 vel = texture(uVelocity, vUv).xy;
      fragColor = vec4(clamp(vel + force * dt, -0.4, 0.4), 0.0, 1.0);
    }`;

  var pressureShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 fragColor;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      float divergence = texture(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      fragColor = vec4(clamp(pressure, -50.0, 50.0), 0.0, 0.0, 1.0);
    }`;

  var gradientSubtractShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 fragColor;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      vec2 velocity = texture(uVelocity, vUv).xy;
      velocity -= vec2(R - L, T - B) * 0.5;
      fragColor = vec4(clamp(velocity, -0.4, 0.4), 0.0, 1.0);
    }`;

  var buoyancyShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv;
    out vec4 fragColor;
    uniform sampler2D uVelocity;
    uniform sampler2D uDensity;
    uniform float dt;
    uniform float buoyancy;
    uniform float ambient;
    uniform float time;
    void main () {
      vec2 vel = texture(uVelocity, vUv).xy;
      vec3 d = texture(uDensity, vUv).rgb;
      float density = min(dot(d, vec3(0.299, 0.587, 0.114)), 1.0);
      float n = sin(vUv.x * 7.0 + time * 0.5) * cos(vUv.y * 5.0 - time * 0.35);
      float lift = buoyancy * density * (1.0 + 0.4 * n) + ambient;
      vel.y += lift * dt;
      vel.x += 0.12 * n * dt;
      fragColor = vec4(clamp(vel, -0.4, 0.4), 0.0, 1.0);
    }`;

  var splatShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv;
    out vec4 fragColor;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture(uTarget, vUv).xyz;
      fragColor = vec4(clamp(base + splat, -4.0, 4.0), 1.0);
    }`;

  var radialForceShader = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv;
    out vec4 fragColor;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec2 point;
    uniform float radius;
    uniform float strength;
    void main () {
      vec2 p = vUv - point;
      vec2 pCorrected = p;
      pCorrected.x *= aspectRatio;
      float dist = length(pCorrected);
      vec2 dir = p / (length(p) + 1e-5);
      float falloff = exp(-dist * dist / radius);
      vec2 force = dir * strength * falloff;
      vec2 base = texture(uTarget, vUv).xy;
      fragColor = vec4(clamp(base + force, -1.2, 1.2), 0.0, 1.0);
    }`;

  var displayShader = `#version 300 es
    precision highp float; precision mediump sampler2D;
    in vec2 vUv;
    out vec4 fragColor;
    uniform sampler2D uTexture;
    void main () {
      vec3 c = texture(uTexture, vUv).rgb;
      float a = clamp(max(max(c.r, c.g), c.b), 0.0, 1.0);
      fragColor = vec4(c * a, a);
    }`;

  var advectionProgram = createProgram(baseVertexShader, advectionShader);
  var divergenceProgram = createProgram(baseVertexShader, divergenceShader);
  var curlProgram = createProgram(baseVertexShader, curlShader);
  var vorticityProgram = createProgram(baseVertexShader, vorticityShader);
  var pressureProgram = createProgram(baseVertexShader, pressureShader);
  var gradientSubtractProgram = createProgram(baseVertexShader, gradientSubtractShader);
  var buoyancyProgram = createProgram(baseVertexShader, buoyancyShader);
  var splatProgram = createProgram(baseVertexShader, splatShader);
  var radialForceProgram = createProgram(baseVertexShader, radialForceShader);
  var displayProgram = createProgram(baseVertexShader, displayShader);

  // ---- framebuffers ----
  var simRes = getRes(SIM_RESOLUTION);
  var dyeRes = getRes(DYE_RESOLUTION);
  var velocity = createDoubleFBO(simRes.width, simRes.height, gl.RG16F, gl.RG, gl.HALF_FLOAT);
  var density = createDoubleFBO(dyeRes.width, dyeRes.height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  var divergence = createFBO(simRes.width, simRes.height, gl.R16F, gl.RED, gl.HALF_FLOAT);
  var curl = createFBO(simRes.width, simRes.height, gl.R16F, gl.RED, gl.HALF_FLOAT);
  var pressure = createDoubleFBO(simRes.width, simRes.height, gl.R16F, gl.RED, gl.HALF_FLOAT);

  var simTexelSize = { x: 1 / simRes.width, y: 1 / simRes.height };

  function splatVelocity(x, y, dx, dy, radius){
    gl.viewport(0, 0, velocity.width, velocity.height);
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, radius || VELOCITY_SPLAT_RADIUS);
    blit(velocity.write);
    velocity.swap();
  }

  function splatDye(x, y, color, dyeRadius){
    gl.viewport(0, 0, density.width, density.height);
    splatProgram.bind();
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform1i(splatProgram.uniforms.uTarget, density.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color[0], color[1], color[2]);
    gl.uniform1f(splatProgram.uniforms.radius, dyeRadius || DYE_SPLAT_RADIUS);
    blit(density.write);
    density.swap();
  }

  function splat(x, y, dx, dy, color, dyeRadius){
    splatVelocity(x, y, dx, dy);
    splatDye(x, y, color, dyeRadius);
  }

  // A click on the background sends a radial shockwave of velocity outward
  // from the click point (pushing any nearby smoke away), plus a small
  // burst of dye so the "puff" is visible even where there's no smoke yet.
  function puff(x, y){
    gl.viewport(0, 0, velocity.width, velocity.height);
    radialForceProgram.bind();
    gl.uniform1i(radialForceProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(radialForceProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(radialForceProgram.uniforms.point, x, y);
    gl.uniform1f(radialForceProgram.uniforms.radius, 0.0005);
    gl.uniform1f(radialForceProgram.uniforms.strength, 100.1);
    blit(velocity.write);
    velocity.swap();

    splatDye(x, y, violetColor(0.8), 0.0005);
  }

  function violetColor(scale){
    var t = Math.random();
    var s = scale == null ? 1 : scale;
    return [(0.26 + 0.24 * t) * s, (0.04 + 0.10 * t) * s, (0.60 + 0.22 * t) * s];
  }

  // Plumes ramp their dye concentration in gradually over a couple of
  // seconds instead of injecting it in one frame, so no visible "pop".
  var activeEmitters = [];

  function spawnPlume(){
    var x = 0.12 + Math.random() * 0.76;
    var y = -0.30 + Math.random() * 0.14;   // spawn below the visible frame
    var dx = (Math.random() - 0.5) * 0.05;
    var dy = 0.05 + Math.random() * 0.07;
    splatVelocity(x, y, dx, dy);
    activeEmitters.push({
      x: x, y: y, dx: dx, dy: dy,
      color: violetColor(0.55),
      radius: 0.11,
      age: 0,
      duration: 1.2 + Math.random() * 1.3
    });
  }

  function updateEmitters(dt){
    for (var i = activeEmitters.length - 1; i >= 0; i--){
      var e = activeEmitters[i];
      e.age += dt;
      var frac = Math.min(dt / e.duration, 1);
      splatDye(e.x, e.y, [e.color[0] * frac, e.color[1] * frac, e.color[2] * frac], e.radius);
      e.x += e.dx * dt;
      e.y += e.dy * dt;
      if (e.age >= e.duration) activeEmitters.splice(i, 1);
    }
  }

  // seed a bed of purple along the bottom, plus a few starter plumes
  for (var bx = 0.06; bx <= 0.96; bx += 0.11){
    splat(bx, 0.02 + Math.random() * 0.02, (Math.random() - 0.5) * 0.015, 0.015, violetColor());
  }
  for (var s = 0; s < 6; s++) spawnPlume();

  var lastTime = performance.now();
  var splatTimer = 0.6;

  function step(dt){
    gl.disable(gl.BLEND);

    gl.viewport(0, 0, simRes.width, simRes.height);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curlStrength, CURL_STRENGTH);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    buoyancyProgram.bind();
    gl.uniform1i(buoyancyProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(buoyancyProgram.uniforms.uDensity, density.read.attach(1));
    gl.uniform1f(buoyancyProgram.uniforms.dt, dt);
    gl.uniform1f(buoyancyProgram.uniforms.buoyancy, BUOYANCY);
    gl.uniform1f(buoyancyProgram.uniforms.ambient, AMBIENT_RISE);
    gl.uniform1f(buoyancyProgram.uniforms.time, lastTime / 1000);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < PRESSURE_ITERATIONS; i++){
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradientSubtractProgram.bind();
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, VELOCITY_DISSIPATION);
    gl.uniform1f(advectionProgram.uniforms.clampMax, 0.4);
    gl.uniform1f(advectionProgram.uniforms.riseBias, 0.0);
    blit(velocity.write);
    velocity.swap();

    gl.viewport(0, 0, dyeRes.width, dyeRes.height);
    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, simTexelSize.x, simTexelSize.y);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, density.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, DENSITY_DISSIPATION);
    gl.uniform1f(advectionProgram.uniforms.clampMax, 8.0);
    gl.uniform1f(advectionProgram.uniforms.riseBias, 0.055);
    blit(density.write);
    density.swap();
  }

  function render(){
    displayProgram.bind();
    gl.uniform1i(displayProgram.uniforms.uTexture, density.read.attach(0));
    blit(null);
  }

  var __frameCount = 0;
  function frame(now){
    var dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;

    splatTimer -= dt;
    if (splatTimer <= 0){
      spawnPlume();
      splatTimer = 0.5 + Math.random() * 0.7;
    }
    updateEmitters(dt);

    step(dt);
    render();
    __frameCount++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- Cursor interaction: moving over the background stirs the dye ----
  var pointer = { x: null, y: null };

  function clientToUV(clientX, clientY){
    return { x: clientX / window.innerWidth, y: 1 - clientY / window.innerHeight };
  }

  function isOverForeground(target){
    return !!(target && target.closest && target.closest('.profile-header, .tabs, .panel-wrap, .site-footer, .lightbox'));
  }

  function stir(uv, dx, dy){
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.0005) return;
    var strength = 9;
    var vx = Math.max(-1.4, Math.min(1.4, dx * strength));
    var vy = Math.max(-1.4, Math.min(1.4, dy * strength));
    splatVelocity(uv.x, uv.y, vx, vy, 0.0005);
  }

  document.addEventListener('pointermove', function(e){
    if (isOverForeground(e.target)){ pointer.x = null; pointer.y = null; return; }
    var uv = clientToUV(e.clientX, e.clientY);
    if (pointer.x !== null) stir(uv, uv.x - pointer.x, uv.y - pointer.y);
    pointer.x = uv.x; pointer.y = uv.y;
  });

  function resetPointer(){ pointer.x = null; pointer.y = null; }
  document.addEventListener('pointerleave', resetPointer);
  window.addEventListener('blur', resetPointer);

  document.addEventListener('click', function(e){
    if (isOverForeground(e.target)) return;
    var uv = clientToUV(e.clientX, e.clientY);
    puff(uv.x, uv.y);
  });
})();
