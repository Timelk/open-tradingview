import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';
import {initializeI18n} from './lib/i18n';
const disposeI18n=initializeI18n();
import {applyMotionPreference,readMotionPreference} from './lib/ui/motion-preferences';
applyMotionPreference(readMotionPreference());
// Theme before first paint: the saved chart appearance re-skins the whole UI.
import {loadAppearance} from './lib/chart/appearance';
import {applyUiTheme} from './lib/ui/theme';
applyUiTheme(loadAppearance());

mount(App, { target: document.getElementById('app')! });

import {installTooltips} from './lib/ui/tooltips';
const disposeTooltips=installTooltips();
if(import.meta.hot)import.meta.hot.dispose(()=>{disposeTooltips();disposeI18n();});
