import React from 'react';
import type { AppPage } from '../App';
import iconUrl from '../brand/image-puma-icon-32.png';

interface TitleBarProps {
  activePage: Exclude<AppPage, 'splash'>;
  onPageChange: (page: Exclude<AppPage, 'splash'>) => void;
  navigationLocked?: boolean;
}

const NAV_ITEMS: Array<{ id: Exclude<AppPage, 'splash'>; label: string }> = [
  { id: 'workbench', label: 'Image Editor' },
  { id: 'background-remover', label: 'Remove Background' },
  { id: 'quick-favicon', label: 'Quick Favicon' },
];

export function TitleBar({ activePage, onPageChange, navigationLocked = false }: TitleBarProps) {
  return (
    <div className="title-bar">
      <span className="app-name">
        <img src={iconUrl} alt="" aria-hidden="true" />
        <span>Image Puma</span>
      </span>
      <nav className="title-tabs" aria-label="Primary workspace">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={activePage === item.id ? 'active' : ''}
            disabled={navigationLocked && activePage !== item.id}
            onClick={() => onPageChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
