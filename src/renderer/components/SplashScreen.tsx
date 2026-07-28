import React, { useEffect, useRef } from 'react';

import brandIcon from '../brand/image-puma-icon-192.png';
import img01 from '../splash/01-jungle-flower.webp';
import img02 from '../splash/02-cartoon-cat.webp';
import img03 from '../splash/03-wooseok.webp';
import img04 from '../splash/04-orange-tree.webp';
import img05 from '../splash/05-hoach.webp';
import img06 from '../splash/06-jeju-orchard.webp';
import img07 from '../splash/07-rainbow-kittens.webp';
import img08 from '../splash/08-seongkwang.webp';
import img09 from '../splash/09-kiril.webp';
import img10 from '../splash/10-marc.webp';
import img11 from '../splash/11-cartoon-cloud.webp';
import img12 from '../splash/12-starry-night.webp';
import img13 from '../splash/13-llama-pajamas.webp';
import img14 from '../splash/14-philippe.webp';
import img15 from '../splash/15-tobias.webp';
import img16 from '../splash/16-lonely-figure.webp';
import img17 from '../splash/17-yma.webp';
import img18 from '../splash/18-zheng.webp';

const ALL_IMAGES = [
  img01, img02, img03, img04, img05, img06,
  img07, img08, img09, img10, img11, img12,
  img13, img14, img15, img16, img17, img18,
];

const CELL_COUNT = 12;
const STAGGER_MS = 80;
const SWAP_INTERVAL_MS = 350;

// Exact same layout as lightlightroom: 5 cols × 4 rows, 12 cells
const CELL_LAYOUT = [
  { col: 1, row: 1, colSpan: 2, rowSpan: 2 }, // large
  { col: 3, row: 1, colSpan: 1, rowSpan: 2 }, // portrait
  { col: 4, row: 1, colSpan: 2, rowSpan: 1 }, // landscape
  { col: 4, row: 2, colSpan: 1, rowSpan: 1 }, // square
  { col: 5, row: 2, colSpan: 1, rowSpan: 1 }, // square
  { col: 1, row: 3, colSpan: 1, rowSpan: 2 }, // portrait
  { col: 2, row: 3, colSpan: 2, rowSpan: 1 }, // landscape
  { col: 4, row: 3, colSpan: 1, rowSpan: 2 }, // portrait
  { col: 5, row: 3, colSpan: 1, rowSpan: 1 }, // square
  { col: 2, row: 4, colSpan: 1, rowSpan: 1 }, // square
  { col: 3, row: 4, colSpan: 1, rowSpan: 1 }, // square
  { col: 5, row: 4, colSpan: 1, rowSpan: 1 }, // square
];

export function SplashScreen() {
  const gridRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    // Shuffle images
    const shuffled = [...ALL_IMAGES].sort(() => Math.random() - 0.5);
    const initialImages = shuffled.slice(0, CELL_COUNT);
    const swapPool = shuffled.slice(CELL_COUNT);

    // Track current image per cell for pool recycling
    const cellCurrentImage: string[] = [...initialImages];

    // Build cells
    const cellEls: HTMLDivElement[] = [];
    for (let i = 0; i < CELL_COUNT; i++) {
      const layout = CELL_LAYOUT[i];
      const cell = document.createElement('div');
      cell.className = 'splash-cell';
      cell.style.gridColumn = `${layout.col} / span ${layout.colSpan}`;
      cell.style.gridRow = `${layout.row} / span ${layout.rowSpan}`;

      const img = document.createElement('img');
      img.src = initialImages[i];
      img.alt = '';
      img.draggable = false;
      cell.appendChild(img);
      grid.appendChild(cell);
      cellEls.push(cell);

      // Staggered reveal
      setTimeout(() => cell.classList.add('visible'), i * STAGGER_MS);
    }

    // Swap animation — matching lightlightroom exactly
    let swapIdx = 0;
    timerRef.current = setInterval(() => {
      if (swapPool.length === 0) return;
      if (swapIdx >= swapPool.length) swapIdx = 0;

      const cellIdx = Math.floor(Math.random() * cellEls.length);
      const newImage = swapPool[swapIdx++];

      // Recycle old image into pool
      swapPool.push(cellCurrentImage[cellIdx]);
      cellCurrentImage[cellIdx] = newImage;

      const imgEl = cellEls[cellIdx].querySelector('img');
      if (imgEl) {
        imgEl.classList.add('swapping');
        setTimeout(() => { imgEl.src = newImage; }, 240);
        setTimeout(() => { imgEl.classList.remove('swapping'); }, 600);
      }
    }, SWAP_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="splash-overlay">
      <div className="splash-grid" ref={gridRef} />

      <div className="splash-center">
        <img className="splash-mark" src={brandIcon} alt="" aria-hidden="true" />
        <div className="splash-title">Image Puma</div>
        <div className="splash-subtitle">Batch image preparation for the web</div>
      </div>

      <div className="splash-skip-hint">Preparing workspace...</div>
    </div>
  );
}
