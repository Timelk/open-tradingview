import {afterEach,it,expect,vi} from 'vitest';
import {ChartController} from '../src/lib/chart/controller';
import {appearancePreset,DEFAULT_APPEARANCE,APPEARANCE_STORAGE_KEY} from '../src/lib/chart/appearance';

afterEach(()=>vi.unstubAllGlobals());
it('preview changes only presentation, cancel restores, commit persists, failures remain retryable',()=>{
  const storage={getItem:()=>null,setItem:vi.fn()};vi.stubGlobal('localStorage',storage);
  const root={style:{setProperty:vi.fn()},dataset:{}};
  const c=Object.assign(Object.create(ChartController.prototype),{host:{closest:()=>root},appearance:{...DEFAULT_APPEARANCE},dirty:false,overlayDirty:false});
  const original=c.getAppearance(),light=appearancePreset('light');c.previewAppearance(light);
  expect(c.getAppearance()).toEqual(light);expect(c.dirty&&c.overlayDirty).toBe(true);expect(storage.setItem).not.toHaveBeenCalled();
  expect(root.style.setProperty).toHaveBeenCalledWith('--bg','#ffffff');
  expect(root.style.setProperty).toHaveBeenCalledWith('--chart-glass-blur','blur(10px) saturate(135%)');
  expect((root.dataset as Record<string,string>).chartTone).toBe('light');
  c.restoreAppearance(original);expect(c.getAppearance()).toEqual(original);expect(storage.setItem).not.toHaveBeenCalled();
  expect((root.dataset as Record<string,string>).chartTone).toBe('dark');
  expect(c.commitAppearance(light)).toBe(true);expect(storage.setItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY,JSON.stringify(light));
  storage.setItem.mockImplementation(()=>{throw Error('QuotaExceededError');});expect(c.commitAppearance(original)).toBe(false);
  c.restoreAppearance(light);expect(c.getAppearance()).toEqual(light);
  const snapshot=c.getAppearance();snapshot.background='#000000';expect(c.getAppearance().background).toBe('#ffffff');
});
