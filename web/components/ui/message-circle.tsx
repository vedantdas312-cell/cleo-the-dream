"use client";

/*! Message Circle — AnimateIcons / Lucide, Avijit Dey (@avijit07x).
MIT License

Copyright (c) 2025 Avijit Dey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// https://github.com/Avijit07x/animateicons
import { cn } from '@/lib/utils';
import { LazyMotion, domAnimation, m, useAnimation, useReducedMotion, type Variants } from 'motion/react';
import { forwardRef, useImperativeHandle, type HTMLAttributes } from 'react';

export interface MessageCircleIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}
interface MessageCircleIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  duration?: number;
  isAnimated?: boolean;
  color?: string;
}

export const MessageCircleIcon = forwardRef<MessageCircleIconHandle, MessageCircleIconProps>(
  ({ size = 24, duration = 1, isAnimated = true, color, className, onMouseEnter, onMouseLeave, ...props }, ref) => {
    const controls = useAnimation();
    const reduced = useReducedMotion();
    const start = () => { void controls.start(isAnimated && !reduced ? 'animate' : 'normal'); };
    const stop = () => { void controls.start('normal'); };
    useImperativeHandle(ref, () => ({ startAnimation: start, stopAnimation: stop }));
    const svgVariants: Variants = {
      normal: { rotate: 0 },
      animate: { rotate: [0, -3, 2, 0], transition: { duration: 0.6 * duration, ease: 'easeInOut' } },
    };
    const popVariants: Variants = {
      normal: { scale: 1 },
      animate: { scale: [0.5, 1.12, 0.96, 1], transition: { duration: 0.55 * duration, times: [0, 0.55, 0.78, 1], ease: 'easeOut' } },
    };
    const pathVariants: Variants = {
      normal: { pathLength: 1, opacity: 1 },
      animate: { pathLength: [0.25, 1], opacity: [0, 1], transition: { duration: 0.5 * duration, ease: 'easeOut' } },
    };
    return <LazyMotion features={domAnimation} strict>
      <div {...props} className={cn('inline-flex items-center justify-center', className)}
        style={{ color, ...props.style }}
        onMouseEnter={event => { if (!ref) start(); onMouseEnter?.(event); }}
        onMouseLeave={event => { if (!ref) stop(); onMouseLeave?.(event); }}>
        <m.svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" animate={controls} initial="normal" variants={svgVariants}>
          <m.g variants={popVariants} style={{ transformBox: 'view-box', originX: '4px', originY: '19px' }}>
            <m.path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" variants={pathVariants} />
          </m.g>
        </m.svg>
      </div>
    </LazyMotion>;
  },
);
MessageCircleIcon.displayName = 'MessageCircleIcon';
