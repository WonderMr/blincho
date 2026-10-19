import React, { useId } from 'react';

export interface SymbioteIconProps {
  mask: number;
  size?: number;
  // Cloud is a dormant art variant, not an application setting or a perk.
  connectionAppearance?: 'mcp' | 'cloud';
}

export const SymbioteIcon: React.FC<SymbioteIconProps> = ({ mask, size = 48, connectionAppearance = 'mcp' }) => {
  const prefix = `symbiote-${useId().replace(/:/g, '')}`;
  const ref = (name: string) => `url(#${prefix}-${name})`;
  const known = mask & 63;
  // Small portraits keep the silhouette and signal, without subpixel decoration.
  const compact = size < 80;
  const edge = compact ? 3.6 : 2;
  if (!known) return <img className="symbiote-icon" src="./icon.png" width={size} height={size} alt="" draggable={false} data-symbiote-mask="0" />;
  return <svg className="symbiote-icon" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false" data-symbiote-mask={known} data-symbiote-detail={compact ? 'compact' : 'full'}>
    <defs>
      <linearGradient id={`${prefix}-metal`} x1=".08" y1="0" x2=".82" y2="1">
        <stop stopColor="#8da7b6" /><stop offset=".22" stopColor="#49667e" />
        <stop offset=".6" stopColor="#29465f" /><stop offset="1" stopColor="#16324a" />
      </linearGradient>
      <linearGradient id={`${prefix}-rim`} x1="0" y1="0" x2=".8" y2="1">
        <stop stopColor="#c7dedf" /><stop offset=".38" stopColor="#7897a5" />
        <stop offset="1" stopColor="#34536b" />
      </linearGradient>
      <linearGradient id={`${prefix}-mint`} x1="0" y1="0" x2=".6" y2="1">
        <stop stopColor="#e0ffef" /><stop offset=".42" stopColor="#a8eed7" /><stop offset="1" stopColor="#6fc5b8" />
      </linearGradient>
      <linearGradient id={`${prefix}-glass`} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#f1fff5" stopOpacity=".16" /><stop offset=".42" stopColor="#a3f8df" stopOpacity=".01" />
        <stop offset="1" stopColor="#52baa9" stopOpacity=".08" />
      </linearGradient>
      <linearGradient id={`${prefix}-peach`} x1="0" y1="0" x2=".5" y2="1">
        <stop stopColor="#ffe3c3" /><stop offset="1" stopColor="#efa78e" />
      </linearGradient>
      {/* Counter-rotate the paints so each fitted part shares the mascot's light. */}
      {[{ name: 'optic', angle: -10 }, { name: 'cuff', angle: 16 }, { name: 'link', angle: -18 }].map(({ name, angle }) =>
        ['metal', 'rim', 'mint', 'glass'].map(material => <linearGradient key={`${name}-${material}`} id={`${prefix}-${name}-${material}`} href={`#${prefix}-${material}`} gradientTransform={`rotate(${angle} .5 .5)`} />))}
      <filter id={`${prefix}-shadow`} x="-35%" y="-35%" width="170%" height="180%" colorInterpolationFilters="sRGB">
        <feDropShadow dx=".8" dy="3" stdDeviation="2.3" floodColor="#102a3c" floodOpacity=".32" />
      </filter>
    </defs>
    <image href="./icon.png" x="0" y="0" width="512" height="512" />
    {known & 2 ? <g className="symbiote-module" data-symbiote-perk="lock" filter={ref('shadow')}>
      <path d="M81 322C71 314 66 323 70 342C77 378 93 408 116 427C127 436 143 439 146 429C147 420 129 398 119 378C108 355 93 332 81 322Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth={edge} />
      <path d="M424 322C434 314 440 322 437 342C431 378 416 408 394 427C383 436 368 439 365 429C363 420 380 398 389 378C400 354 412 332 424 322Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth={edge} />
      <path d="M87 349C95 367 105 384 117 398M419 349C412 367 403 384 392 398" fill="none" stroke="#19354a" strokeWidth={compact ? 15 : 12} strokeLinecap="round" />
      <path d="M87 349C95 367 105 384 117 398M419 349C412 367 403 384 392 398" fill="none" stroke={ref('mint')} strokeWidth={compact ? 8 : 6.5} strokeLinecap="round" />
      {!compact && <g data-art-detail="micro">
        <path d="M77 335C83 370 99 401 121 420M429 335C424 369 410 401 389 420" fill="none" stroke="#c1d6d8" strokeWidth="2.6" strokeLinecap="round" opacity=".52" />
        <path d="M115 413L129 428M394 413L381 428" stroke="#16324a" strokeWidth="2" strokeLinecap="round" opacity=".65" />
        <circle cx="79" cy="333" r="3" fill="#d0e3df" opacity=".65" /><circle cx="429" cy="333" r="3" fill="#b4d0d0" opacity=".6" />
      </g>}
    </g> : null}
    {known & 16 ? <g className="symbiote-module" data-symbiote-perk="strict" filter={ref('shadow')}>
      <path d="M105 146C112 107 150 77 192 78C209 78 225 83 232 92C237 100 227 107 212 105C175 101 144 114 121 146C113 157 103 157 105 146Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth={edge} />
      <path d="M128 126C145 108 167 99 190 98" fill="none" stroke="#19354a" strokeWidth={compact ? 13 : 10} strokeLinecap="round" />
      <path d="M129 125C147 108 167 101 190 100" fill="none" stroke={ref('mint')} strokeWidth={compact ? 7 : 5} strokeLinecap="round" />
      {!compact && <g data-art-detail="micro">
        <path d="M117 132C138 102 165 88 191 89" fill="none" stroke="#c7dedf" strokeWidth="2.8" strokeLinecap="round" opacity=".62" />
        <path d="M207 88L215 96" stroke="#1b374d" strokeWidth="2.6" strokeLinecap="round" />
      </g>}
    </g> : null}
    {known & 8 ? <g className="symbiote-module" data-symbiote-perk="input" filter={ref('shadow')}>
      {[[246, 153, 28], [274, 136, 45], [302, 119, 62]].map(([x, y, height]) => <g key={x}>
        <rect x={x} y={y} width="19" height={height} rx="9.5" fill={ref('metal')} stroke={ref('rim')} strokeWidth={edge} />
        <rect x={x + 4.5} y={y + 4.5} width="10" height={height - 9} rx="5" fill={ref('mint')} />
        {!compact && <path data-art-detail="micro" d={`M${x + 5} ${y + height - 7}v-${height - 17}`} stroke="#eafff3" strokeWidth="1.6" opacity=".52" strokeLinecap="round" />}
      </g>)}
    </g> : null}
    {known & 1 ? <g className="symbiote-module" data-symbiote-perk="presence">
      <g transform="rotate(10 185 247)">
        <path d="M185 186C156 186 141 214 141 247C141 281 156 309 185 309C214 309 229 281 229 247C229 214 214 186 185 186ZM185 197C207 197 217 219 217 247C217 276 207 298 185 298C163 298 153 276 153 247C153 219 163 197 185 197Z" fill={ref('optic-metal')} fillRule="evenodd" stroke={ref('optic-rim')} strokeWidth={edge} filter={ref('shadow')} />
        <ellipse cx="185" cy="247" rx="31.5" ry="50" fill={ref('optic-glass')} />
        <ellipse cx="185" cy="247" rx="32.5" ry="51" fill="none" stroke="#a3d7cb" strokeWidth={compact ? 2.8 : 1.8} opacity=".7" />
        <rect x="133" y="228" width="13" height="32" rx="6.5" fill={ref('peach')} stroke="#d8bcaa" strokeWidth={compact ? 2 : 1.3} />
        {!compact && <g data-art-detail="micro">
          <path d="M151 225C155 206 165 195 179 194" fill="none" stroke="#d5e9e5" strokeWidth="2.6" strokeLinecap="round" opacity=".72" />
          <path d="M164 209L157 224" stroke="#e9fff3" strokeWidth="3" strokeLinecap="round" opacity=".24" />
          <path d="M187 190V193M188 302V305" stroke="#0f2c40" strokeWidth="2" strokeLinecap="round" />
        </g>}
      </g>
    </g> : null}
    {known & 4 ? <g className="symbiote-module" data-symbiote-perk="calls" filter={ref('shadow')}>
      <g transform="translate(2 10) rotate(-16 415 216)">
        <path d="M410 161C429 154 444 168 446 190L449 231C450 252 439 267 422 266C407 266 400 255 400 241L398 189C397 175 401 164 410 161Z" fill={ref('cuff-metal')} stroke={ref('cuff-rim')} strokeWidth={edge} />
        <path d="M416 179C427 174 435 184 435 197L438 234C439 245 433 253 425 252C417 251 414 244 414 235L411 195C410 187 412 182 416 179Z" fill="#173247" stroke="#537585" strokeWidth={compact ? 2.8 : 1.7} />
        {compact ? <path d="M422 188L425 239" fill="none" stroke={ref('cuff-mint')} strokeWidth="9" strokeLinecap="round" /> : <g>
          <path d="M422 186L423 206M424 222L425 241" stroke={ref('cuff-mint')} strokeWidth="6.5" strokeLinecap="round" />
          <g data-art-detail="micro">
            <path d="M407 179C414 169 428 171 435 182" fill="none" stroke="#b9d1d2" strokeWidth="2.5" strokeLinecap="round" opacity=".6" />
            <path d="M418 213L430 212" stroke="#719591" strokeWidth="1.6" strokeLinecap="round" opacity=".75" />
          </g>
        </g>}
      </g>
    </g> : null}
    {known & 32 ? <g className="symbiote-module" data-symbiote-perk="mcp" filter={ref('shadow')}>
      <g transform="translate(0 -8) rotate(18 371 128)">
        <path d="M349 145C359 144 381 150 391 152L388 165C375 167 359 162 350 157Z" fill="#203e55" stroke={ref('link-rim')} strokeWidth={edge} />
        <path d="M339 96C353 88 380 90 393 103C404 116 408 140 400 151C392 162 367 159 349 149C334 140 329 107 339 96Z" fill={ref('link-metal')} stroke={ref('link-rim')} strokeWidth={edge} />
        {connectionAppearance === 'cloud' ? <path data-connection-appearance="cloud" d="M349 133C341 133 339 122 347 118C346 107 359 103 366 111C374 106 385 112 384 120C394 121 395 133 386 136H353Z" fill={ref('link-mint')} /> :
          <g data-connection-appearance="mcp">
            <rect x="341" y="107" width="55" height="36" rx="10" fill="#112d42" stroke="#72969f" strokeWidth={compact ? 3 : 1.8} />
            {compact ? <path d="M358 115L369 125L358 135" fill="none" stroke={ref('link-mint')} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /> :
              <path d="M352 116L361 125L352 134M372 133H384" fill="none" stroke={ref('link-mint')} strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />}
          </g>}
        {!compact && <g data-art-detail="micro">
          <path d="M341 106C349 97 370 97 383 103" fill="none" stroke="#c8dedc" strokeWidth="2.6" opacity=".64" strokeLinecap="round" />
          <circle cx="388" cy="148" r="4" fill={ref('peach')} />
          <path d="M362 157L378 161" stroke="#82afa8" strokeWidth="2" strokeLinecap="round" opacity=".75" />
        </g>}
      </g>
    </g> : null}
  </svg>;
};
