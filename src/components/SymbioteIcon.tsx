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
  if (!known) return <img className="symbiote-icon" src="./icon.png" width={size} height={size} alt="" draggable={false} data-symbiote-mask="0" />;
  return <svg className="symbiote-icon" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false" data-symbiote-mask={known}>
    <defs>
      <linearGradient id={`${prefix}-metal`} x1="0" y1="0" x2=".85" y2="1">
        <stop offset="0" stopColor="#8199ab" /><stop offset=".18" stopColor="#365473" />
        <stop offset=".52" stopColor="#203b59" /><stop offset="1" stopColor="#0c1d35" />
      </linearGradient>
      <linearGradient id={`${prefix}-rim`} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#d3e8e9" /><stop offset=".4" stopColor="#7797aa" /><stop offset="1" stopColor="#17344f" />
      </linearGradient>
      <linearGradient id={`${prefix}-mint`} x1="0" y1="0" x2=".55" y2="1">
        <stop stopColor="#effff3" /><stop offset=".4" stopColor="#b5f7df" /><stop offset="1" stopColor="#69c8bd" />
      </linearGradient>
      <linearGradient id={`${prefix}-glass`} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#f1fff5" stopOpacity=".28" /><stop offset=".45" stopColor="#a3f8df" stopOpacity=".02" />
        <stop offset="1" stopColor="#52baa9" stopOpacity=".18" />
      </linearGradient>
      <linearGradient id={`${prefix}-peach`} x1="0" y1="0" x2=".5" y2="1">
        <stop stopColor="#ffe3c3" /><stop offset="1" stopColor="#f3a58c" />
      </linearGradient>
      <filter id={`${prefix}-shadow`} x="-45%" y="-45%" width="190%" height="205%" colorInterpolationFilters="sRGB">
        <feDropShadow dx="0" dy="4" stdDeviation="3" floodColor="#07182b" floodOpacity=".48" />
      </filter>
    </defs>
    <image href="./icon.png" x="0" y="0" width="512" height="512" />
    {known & 2 ? <g className="symbiote-module" data-symbiote-perk="lock" filter={ref('shadow')}>
      <path d="M79 322C73 313 67 318 69 338C72 382 91 422 119 438C134 447 151 445 148 433C141 408 124 390 113 366C102 343 91 332 79 322Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth="2.4" />
      <path d="M77 331C80 368 99 406 123 426" fill="none" stroke="#9db6c5" strokeWidth="3" strokeLinecap="round" opacity=".75" />
      <path d="M86 353C95 370 103 383 113 394" fill="none" stroke="#061b31" strokeWidth="11" strokeLinecap="round" />
      <path d="M85 351C94 368 103 382 114 394" fill="none" stroke={ref('mint')} strokeWidth="6.5" strokeLinecap="round" />
      <path d="M425 322C436 309 442 315 440 338C437 381 420 421 394 438C380 447 365 444 369 431C376 407 390 387 399 365C409 343 416 332 425 322Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth="2.4" />
      <path d="M432 332C427 373 413 402 390 424" fill="none" stroke="#8daaba" strokeWidth="3" strokeLinecap="round" opacity=".65" />
      <path d="M421 352C411 370 405 382 397 393" fill="none" stroke="#061b31" strokeWidth="11" strokeLinecap="round" />
      <path d="M422 351C412 369 405 382 397 393" fill="none" stroke={ref('mint')} strokeWidth="6.5" strokeLinecap="round" />
    </g> : null}
    {known & 16 ? <g className="symbiote-module" data-symbiote-perk="strict" filter={ref('shadow')}>
      <path d="M104 150C111 105 152 74 198 77C217 78 234 85 241 94C247 103 235 110 217 108C174 103 143 116 120 150C113 161 101 163 104 150Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth="2.3" />
      <path d="M117 135C139 101 173 88 207 91" fill="none" stroke="#a3bbca" strokeWidth="4" strokeLinecap="round" opacity=".7" />
      <path d="M128 126C149 105 174 97 196 98" fill="none" stroke="#0d243b" strokeWidth="9" strokeLinecap="round" />
      <path d="M129 125C150 105 173 99 195 99" fill="none" stroke={ref('mint')} strokeWidth="5" strokeLinecap="round" />
    </g> : null}
    {known & 8 ? <g className="symbiote-module" data-symbiote-perk="input" filter={ref('shadow')}>
      {[[126, 157, 23], [156, 138, 40], [186, 118, 58]].map(([x, y, height]) => <g key={x}>
        <rect x={x} y={y} width="19" height={height + 8} rx="9.5" fill={ref('metal')} stroke={ref('rim')} strokeWidth="1.7" />
        <rect x={x + 5} y={y + 5} width="9" height={height - 2} rx="4.5" fill={ref('mint')} />
        <path d={`M${x + 5} ${y + height + 1}v-${height - 8}`} stroke="#effff4" strokeWidth="1.8" opacity=".8" strokeLinecap="round" />
      </g>)}
    </g> : null}
    {known & 1 ? <g className="symbiote-module" data-symbiote-perk="presence" filter={ref('shadow')}>
      <g transform="rotate(10 185 247)">
        <path d="M185 181C154 181 139 211 139 247C139 284 154 314 185 314C216 314 231 284 231 247C231 211 216 181 185 181ZM185 194C207 194 217 218 217 247C217 277 207 301 185 301C163 301 153 277 153 247C153 218 163 194 185 194Z" fill={ref('metal')} fillRule="evenodd" stroke={ref('rim')} strokeWidth="2.5" />
        <ellipse cx="185" cy="247" rx="32" ry="53" fill={ref('glass')} />
        <ellipse cx="185" cy="247" rx="33" ry="54" fill="none" stroke="#a6e8d9" strokeWidth="2.4" opacity=".8" />
        <path d="M150 226C153 203 165 190 182 189" fill="none" stroke="#dcecf0" strokeWidth="3.5" strokeLinecap="round" opacity=".85" />
        <rect x="132" y="224" width="15" height="38" rx="7.5" fill={ref('peach')} stroke="#f6d0b7" strokeWidth="1.5" />
      </g>
    </g> : null}
    {known & 4 ? <g className="symbiote-module" data-symbiote-perk="calls" filter={ref('shadow')}>
      <g transform="rotate(-16 415 216)">
        <path d="M411 160C433 154 447 170 448 193L450 229C451 253 438 272 418 269C404 267 398 255 399 241L398 187C397 173 401 163 411 160Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth="2.4" />
        <path d="M408 174C424 164 436 176 437 190" fill="none" stroke="#b8ccd5" strokeWidth="3" strokeLinecap="round" opacity=".7" />
        <path d="M420 182L423 208M424 224L425 248" stroke="#091f36" strokeWidth="12" strokeLinecap="round" />
        <path d="M420 181L423 207M424 223L425 247" stroke={ref('mint')} strokeWidth="6.8" strokeLinecap="round" />
      </g>
    </g> : null}
    {known & 32 ? <g className="symbiote-module" data-symbiote-perk="mcp" filter={ref('shadow')}>
      <g transform="rotate(18 371 128)">
        <path d="M338 95C352 86 381 88 395 102C406 115 411 142 402 154C394 166 367 162 348 151C332 142 327 106 338 95Z" fill={ref('metal')} stroke={ref('rim')} strokeWidth="2.4" />
        <path d="M339 106C346 95 371 94 386 103" fill="none" stroke="#bbd0da" strokeWidth="3" opacity=".72" strokeLinecap="round" />
        {connectionAppearance === 'cloud' ? <path data-connection-appearance="cloud" d="M348 132C340 132 338 120 346 116C345 105 359 101 366 109C374 104 386 110 385 119C395 119 398 133 387 136L352 136Z" fill={ref('mint')} stroke="#b6f4df" strokeWidth="1.5" /> :
          <g data-connection-appearance="mcp">
            <rect x="341" y="108" width="54" height="34" rx="15" fill="#0b2339" stroke="#71929e" strokeWidth="2" />
            <path d="M354 116L363 125L354 134M371 133H383" fill="none" stroke={ref('mint')} strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>}
        <circle cx="389" cy="149" r="5.7" fill={ref('peach')} stroke="#f8d9c5" strokeWidth="1.2" />
      </g>
    </g> : null}
  </svg>;
};
