'use client';

import { useEffect } from 'react';

export default function HomePage() {
  useEffect(() => {
    void import('../client/initTtcApp').then((m) => m.mountTtcWatcher());
  }, []);

  return (
    <div className="app" id="app-root">
      <section className="detail" aria-label="Map and routes">
        <div id="map" role="application" aria-label="Vehicle map" />
        <button
          type="button"
          id="sidebar-toggle"
          className="map-drawer-toggle"
          aria-expanded={false}
          aria-controls="app-sidebar"
          title="Open routes and stops"
        >
          <span className="map-drawer-toggle__icon" aria-hidden="true" />
          <span className="map-drawer-toggle__label">Menu</span>
        </button>
        <div id="sidebar-backdrop" className="sidebar-backdrop" hidden aria-hidden="true" />
        <aside id="app-sidebar" className="sidebar sidebar--drawer" aria-label="Routes and stops">
          <div className="sidebar__head">
            <div className="sidebar__head-row">
              <h1 className="title">TTC Watcher</h1>
              <button type="button" id="sidebar-close" className="sidebar-close" aria-label="Close menu">
                ×
              </button>
            </div>
            <p className="subtitle">
              Live vehicles from{' '}
              <a href="https://bustime.ttc.ca/gtfsrt/" rel="noreferrer">
                GTFS-RT
              </a>
              , schedules via{' '}
              <a href="https://myttc.ca/developers" rel="noreferrer">
                MyTTC
              </a>
              .
            </p>
          </div>
          <div className="sidebar-tabs" role="tablist">
            <button type="button" className="sidebar-tab is-active" data-sidebar="routes">
              Routes
            </button>
            <button type="button" className="sidebar-tab" data-sidebar="stops">
              Stops
            </button>
          </div>
          <div id="panel-routes" className="sidebar-panel">
            <div className="toolbar">
              <input id="search" type="search" placeholder="Search routes…" autoComplete="off" />
            </div>
            <div id="route-accordion" className="sidebar__accordion">
              <div className="accordion__scroll-y">
                <div className="route-mode-tabs" role="tablist" aria-label="Route categories">
                  <button
                    type="button"
                    className="route-mode-tab is-active"
                    role="tab"
                    aria-selected={true}
                    data-route-section="pinned"
                    aria-label="Pinned routes"
                  >
                    📌
                  </button>
                  <button
                    type="button"
                    className="route-mode-tab"
                    role="tab"
                    aria-selected={false}
                    data-route-section="train"
                    aria-label="Train and LRT routes"
                  >
                    🚇
                  </button>
                  <button
                    type="button"
                    className="route-mode-tab"
                    role="tab"
                    aria-selected={false}
                    data-route-section="streetcar"
                    aria-label="Streetcar routes"
                  >
                    🚋
                  </button>
                  <button
                    type="button"
                    className="route-mode-tab"
                    role="tab"
                    aria-selected={false}
                    data-route-section="bus"
                    aria-label="Bus routes"
                  >
                    🚌
                  </button>
                </div>
                <div id="expanded-panel-pinned" className="route-expanded-panel" role="tabpanel">
                  <div className="route-section__body">
                    <ul id="pinned-list" className="line-list line-list--compact" />
                    <p id="pinned-empty" className="sidebar__empty">
                      Pin routes to keep their vehicles visible on the map.
                    </p>
                  </div>
                </div>
                <div id="expanded-panel-train" className="route-expanded-panel" role="tabpanel" hidden>
                  <div className="route-section__body">
                    <ul id="routes-list-train" className="line-list" />
                    <p id="empty-train" className="sidebar__empty sidebar__empty--section" hidden>
                      No train or LRT routes match.
                    </p>
                  </div>
                </div>
                <div id="expanded-panel-streetcar" className="route-expanded-panel" role="tabpanel" hidden>
                  <div className="route-section__body">
                    <ul id="routes-list-streetcar" className="line-list" />
                    <p id="empty-streetcar" className="sidebar__empty sidebar__empty--section" hidden>
                      No streetcar routes match.
                    </p>
                  </div>
                </div>
                <div id="expanded-panel-bus" className="route-expanded-panel" role="tabpanel" hidden>
                  <div className="route-section__body">
                    <ul id="routes-list-bus" className="line-list" />
                    <p id="empty-bus" className="sidebar__empty sidebar__empty--section" hidden>
                      No bus routes match.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div id="panel-stops" className="sidebar-panel" hidden>
            <div className="toolbar">
              <input
                id="stop-search"
                type="search"
                placeholder="Search stops (type 2+ letters)…"
                autoComplete="off"
              />
            </div>
            <p id="stop-search-hint" className="sidebar__empty">
              Results load as you type; full stop list is not preloaded.
            </p>
            <ul id="stops-list" className="stop-list" />
          </div>
          <div className="sidebar__footer">
            <span id="status" className="status" aria-live="polite" />
          </div>
        </aside>
        <div id="map-legend" className="map-legend" hidden />
        <div id="inspect-panel" className="inspect-panel" hidden>
          <div className="inspect-panel__head">
            <h2 id="inspect-title" className="inspect-panel__title"></h2>
            <button type="button" id="inspect-close" className="inspect-close" aria-label="Close panel">
              ×
            </button>
          </div>
          <div id="inspect-body" className="inspect-panel__body" />
        </div>
      </section>
    </div>
  );
}
