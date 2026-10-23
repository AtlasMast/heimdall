import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';
import { createStateChannel } from '../app/stateChannel.js';
import { LocationControls } from './location.js';
import { FavoritesControls } from './favoritesControls.js';
import {
  FavoritesStore,
  favoriteViewFromHash,
  normalizeFavoriteName,
} from '../favorites.js';
import { decodeLayerStateParams } from '../data/layerState.js';

/** Own destination selection, lookup, orbit and world-jump lifetime. */
export class LocationNavigation {
  constructor({
    viewer,
    placeSearch,
    services,
    elements,
    navigation,
    readCockpit,
    operations,
  }) {
    Object.assign(
      this,
      { viewer, placeSearch, services, navigation, readCockpit },
      elements,
      operations,
    );
    this._disposed = false;
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null;
    this._currentPoi = null;
    this._searchedLocationLabel = null;
    this._trafficTransitionTimer = null;
    this._globeResetPromise = null;
    this._cancelGlobeReset = null;
    this._worldJumpActive = false;
    this._favorites = null;
    this._favoritesControls = null;
    this._favoritesStorageWarned = false;
    this._activeFavoriteId = null;
    this.orbitController = new services.OrbitController(viewer);
    this._orbitIndicator = null;
    this._locationState = createStateChannel(
      () => this._locationLookup?.getState() || null,
    );
    this._locationState.subscribe(
      ({ state, change }) => this._handleLocationSearchState(state, change),
      { emitCurrent: false },
    );
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get _navigationGeneration() {
    return this.navigation._navigationGeneration;
  }
  get _activeLocationSearchGeneration() {
    return this.navigation._activeLocationSearchGeneration;
  }
  set _activeLocationSearchGeneration(value) {
    this.navigation._activeLocationSearchGeneration = value;
  }

  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return {
        ok: false,
        orbiting: false,
        error: 'No active landmark to orbit — fly to a landmark first',
      };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  subscribeLocationSearch(listener, options) {
    return this._locationState.subscribe(listener, options);
  }

  _handleLocationSearchState(state, change) {
    if (this._disposed || !change) return;
    if (change.type === 'started')
      this._activeLocationSearchGeneration = change.generation;
    else if (change.type === 'found') {
      this._searchedLocationLabel = state.destination.label || state.query;
      this._activeFavoriteId = null;
      this._favoritesControls?.highlight(null);
      this._setActiveLocation(null);
      this._currentPoi = null;
      this._collapsePOIRow();
      this._updateLocationMiniStatus();
    } else if (change.type === 'missing')
      this._showToast(t('Location not found'));
    else if (change.type === 'failed') this._showToast(t('Search failed'));
    else if (change.type === 'settled')
      this._settleLocationSearchUi(change.generation);
    else if (
      change.type === 'reset' &&
      this._activeLocationSearchGeneration !== null
    ) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
  }

  _initLocationBar() {
    const { CITY_POIS, searchAndFlyTo, LocationSearch } = this.services;
    this._locationControls?.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      input: this._locationSearch,
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) =>
        !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) =>
        searchAndFlyTo(this.viewer, query, {
          placeSearch: this.placeSearch,
          ...options,
        }),
      onResult: (destination) => {
        if (destination.outlineUnavailable)
          this._showToast(t('Detailed outline unavailable'));
      },
      onError: (error) => console.error('[Search] Geocoding failed:', error),
    });
    this._locationLookupUnsubscribe = this._locationLookup.subscribe(
      ({ initial, change }) => {
        this._locationState.publish(initial ? { type: 'reset' } : change);
      },
    );
    this._locationControls = new LocationControls({
      elements: {
        pills: this._locationPills,
        poiRow: this._poiRow,
        divider: this._locationBarDivider,
        search: this._locationSearch,
        searchToggle: this._searchToggle,
        resetButtons: [this._resetGlobeBtn, this._cockpitResetGlobeBtn],
        statusCity: this._locationMiniCity,
        statusPoi: this._locationMiniPoi,
      },
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onReset: () => this.resetToGlobeView(),
    });
    this._initFavorites();
  }

  _initFavorites() {
    this._favoritesControls?.destroy();
    this._favorites ||= new FavoritesStore();
    this._favoritesControls = new FavoritesControls({
      elements: {
        saveButton: this._favoriteSaveBtn,
        nameInput: this._favoriteNameInput,
        list: this._favoritesList,
      },
      suggestName: () => this._suggestFavoriteName(),
      onSave: (name) => this.saveFavorite(name),
      onFly: (id) => this.flyToFavorite(id),
      onDelete: (id) => this.deleteFavorite(id),
    });
    this._renderFavorites();
  }

  _renderFavorites() {
    this._favoritesControls?.render(this._favorites?.list() || []);
    this._favoritesControls?.highlight(this._activeFavoriteId);
  }

  _warnFavoritesNotPersisted(persisted) {
    if (persisted || this._favoritesStorageWarned) return;
    this._favoritesStorageWarned = true;
    this._showToast(
      t('Browser storage is unavailable — favorites last until reload'),
    );
  }

  _suggestFavoriteName() {
    const { CITY_POIS } = this.services;
    const city = this._activeLocationId
      ? CITY_POIS?.[this._activeLocationId]
      : null;
    const base = city
      ? [city.name, this._currentPoi?.name].filter(Boolean).join(' · ')
      : String(this._searchedLocationLabel || '').split(',')[0];
    return normalizeFavoriteName(base);
  }

  /** Save the current view under a name. Returns false when nothing was saved. */
  saveFavorite(name) {
    if (this._disposed || !this._favorites) return false;
    const label = normalizeFavoriteName(name);
    if (!label) {
      this._showToast(t('Name the view to save it'));
      return false;
    }
    const hash = this.snapshotShareHash?.();
    const result = hash
      ? this._favorites.add(label, hash)
      : { ok: false, reason: 'invalid-view' };
    if (!result.ok) {
      this._showToast(
        result.reason === 'full'
          ? t('Favorites are full — delete one first')
          : t('This view cannot be saved yet'),
      );
      return result.reason === 'full';
    }
    this._activeFavoriteId = result.favorite.id;
    this._renderFavorites();
    this._showToast(t('Saved {name}', { name: label }));
    this._warnFavoritesNotPersisted(result.persisted);
    return true;
  }

  deleteFavorite(id) {
    if (this._disposed || !this._favorites) return;
    const result = this._favorites.remove(id);
    if (!result.ok) return;
    if (this._activeFavoriteId === id) this._activeFavoriteId = null;
    this._renderFavorites();
    this._warnFavoritesNotPersisted(result.persisted);
  }

  /** Fly to a saved favorite's exact pose and bring its saved layers back. */
  flyToFavorite(id) {
    const { flyToSavedView } = this.services;
    const favorite = this._favorites?.get(id);
    const view = favorite ? favoriteViewFromHash(favorite.hash) : null;
    if (this._disposed || !view || typeof flyToSavedView !== 'function')
      return false;
    this._stopOrbit();
    const result = this._flyWithTransition(true, (hooks) =>
      flyToSavedView(this.viewer, view, hooks),
    );
    if (result === false) return false;
    const layerState = decodeLayerStateParams(
      new URLSearchParams(favorite.hash),
    );
    if (layerState) void this.applyLayerState?.(layerState);
    this._setActiveLocation(null);
    this._collapsePOIRow();
    this._currentPoi = null;
    this._currentTarget = null;
    this._searchedLocationLabel = favorite.name;
    this._activeFavoriteId = id;
    this._favoritesControls?.highlight(id);
    this._updateLocationMiniStatus();
    return true;
  }

  _beginWorldJumpTransition() {
    const { suspendDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = true;
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  _endWorldJumpTransition() {
    const { resumeDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = false;
    this._trafficTransitionTimer = null;
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed || this._disposed) return;
        completed = true;
        this._endWorldJumpTransition();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  _onCityPillClick(cityId) {
    const { CITY_POIS, flyToPresetLocation } = this.services;
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPresetLocation(this.viewer, cityId, hooks),
    );
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
  }

  _onPoiClick(cityId, poiIndex) {
    const { CITY_POIS, flyToPOI } = this.services;
    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPOI(this.viewer, cityId, poiIndex, hooks),
    );
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
  }

  _expandPOIRow(cityId) {
    const { CITY_POIS } = this.services;
    if (!CITY_POIS[cityId]) return;
    this._expandedCityId = cityId;
    this._locationControls.showPois(cityId);
  }

  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._locationControls.hidePois();
  }

  _updatePoiHighlight() {
    this._locationControls.highlightPoi(this._activePoiIndex);
  }

  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    if (locationId) {
      this._activeFavoriteId = null;
      this._favoritesControls?.highlight(null);
    }
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationControls?.highlightCity(locationId);
    this._updateLocationMiniStatus();
  }

  _updateLocationMiniStatus() {
    const { CITY_POIS } = this.services;
    this._locationControls?.renderStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
  }

  _initOrbit() {
    this._orbitIndicator = this._locationControls.createOrbitIndicator();
  }

  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast(t('Fly to a POI first'));
      return;
    }

    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._orbitIndicator.classList.toggle('active', isActive);
  }

  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._orbitIndicator.classList.remove('active');
    }
  }

  resetToGlobeView() {
    const {
      GLOBE_VIEW,
      flyToGlobeView,
      interruptCameraMotion,
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.services;
    if (this._disposed)
      return Promise.resolve({
        ok: false,
        action: 'zoom_to_globe',
        cancelled: true,
      });
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try {
        flightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: 'tool' });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

    let resolveReset;
    const resetPromise = new Promise((resolve) => {
      resolveReset = resolve;
    });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._resetGlobeBtn?.setAttribute(
        'aria-label',
        t('Reset to full globe view'),
      );
      this._cockpitResetGlobeBtn?.setAttribute(
        'aria-label',
        t('Reset cockpit to full globe view'),
      );
      this._globeResetPromise = null;
      this._cancelGlobeReset = null;
      resolveReset(result);
    };
    this._cancelGlobeReset = () => finish(true);
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(
        !Number.isFinite(height) ||
          Math.abs(height - GLOBE_VIEW.heightM) > 1000,
      );
    }, 4200);
    this._resetGlobeBtn?.setAttribute(
      'aria-label',
      t('Resetting to full globe view'),
    );
    this._cockpitResetGlobeBtn?.setAttribute(
      'aria-label',
      t('Resetting cockpit to full globe view'),
    );
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  /** Revoke callbacks and settle owned camera work before the viewer is released. */
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._locationState.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookupUnsubscribe = null;
    this._locationLookup?.destroy();
    this._locationControls?.destroy();
    this._favoritesControls?.destroy();
    this._cancelGlobeReset?.();
    this._cancelGlobeReset = null;
    if (this._worldJumpActive) this._endWorldJumpTransition();
    clearTimeout(this._trafficTransitionTimer);
    this._trafficTransitionTimer = null;
    this.orbitController?.stop();
  }
}
