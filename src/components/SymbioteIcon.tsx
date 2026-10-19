import React from 'react';
import { getSymbioteIconPath, normalizeSymbioteMask } from '../utils/symbioteIcons';

export interface SymbioteIconProps {
  mask: number;
  size?: number;
}

export const SymbioteIcon: React.FC<SymbioteIconProps> = ({ mask, size = 48 }) =>
  <img className="symbiote-icon" src={getSymbioteIconPath(mask)} width={size} height={size}
    alt="" draggable={false} data-symbiote-mask={normalizeSymbioteMask(mask)} />;
