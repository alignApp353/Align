(function(){
  'use strict';

  const PRIMARY_KEY='alygnn_candidate_theme';
  const LEGACY_KEY='alygnn-theme';
  const ALLOWED=new Set(['system','light','dark']);
  const media=window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function getPreference(){
    const primary=localStorage.getItem(PRIMARY_KEY);
    if(ALLOWED.has(primary)) return primary;

    const legacy=localStorage.getItem(LEGACY_KEY);
    if(ALLOWED.has(legacy)){
      localStorage.setItem(PRIMARY_KEY,legacy);
      return legacy;
    }

    return 'system';
  }

  function resolve(preference){
    if(preference==='dark') return 'dark';
    if(preference==='light') return 'light';
    return media && media.matches ? 'dark' : 'light';
  }

  function palette(effective){
    return effective==='dark'
      ? {
          '--bg':'#0E151D',
          '--card':'#15202B',
          '--card-bg':'#15202B',
          '--text':'#F4F7F9',
          '--muted':'#A7B2BD',
          '--text-muted':'#A7B2BD',
          '--border':'#2B3946',
          '--soft':'#1C2934',
          '--brand-light':'rgba(93,127,163,.18)'
        }
      : {
          '--bg':'#F5F8F8',
          '--card':'#FFFFFF',
          '--card-bg':'#FFFFFF',
          '--text':'#172333',
          '--muted':'#66788A',
          '--text-muted':'#66788A',
          '--border':'#DCE5EB',
          '--soft':'#EFF4F7',
          '--brand-light':'rgba(93,127,163,.10)'
        };
  }

  function updateThemeColor(effective){
    let meta=document.querySelector('meta[name="theme-color"]');
    if(!meta){
      meta=document.createElement('meta');
      meta.name='theme-color';
      document.head.appendChild(meta);
    }
    meta.content=effective==='dark' ? '#0E151D' : '#F5F8F8';
  }

  function apply(preference=getPreference()){
    const pref=ALLOWED.has(preference) ? preference : 'system';
    const effective=resolve(pref);
    const root=document.documentElement;

    root.dataset.theme=pref;
    root.dataset.effectiveTheme=effective;
    root.style.colorScheme=effective;

    Object.entries(palette(effective)).forEach(([name,value])=>{
      root.style.setProperty(name,value);
    });

    if(document.body){
      document.body.dataset.theme=pref;
      document.body.dataset.effectiveTheme=effective;
    }

    updateThemeColor(effective);

    window.dispatchEvent(new CustomEvent('alygnn-theme-applied',{
      detail:{preference:pref,effective}
    }));

    return {preference:pref,effective};
  }

  function set(preference){
    const next=ALLOWED.has(preference) ? preference : 'system';

    localStorage.setItem(PRIMARY_KEY,next);
    // Keep older Alygnn candidate pages compatible while the app is migrated.
    localStorage.setItem(LEGACY_KEY,next);

    return apply(next);
  }

  function syncBody(){
    if(document.body){
      document.body.dataset.theme=getPreference();
      document.body.dataset.effectiveTheme=resolve(getPreference());
    }
  }

  window.AlygnnCandidateTheme={
    get:getPreference,
    set,
    apply,
    effective:()=>resolve(getPreference())
  };

  apply();

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{
      syncBody();
      apply();
    },{once:true});
  }else{
    syncBody();
    apply();
  }

  if(media){
    const onChange=()=>{
      if(getPreference()==='system') apply('system');
    };
    if(media.addEventListener) media.addEventListener('change',onChange);
    else if(media.addListener) media.addListener(onChange);
  }

  window.addEventListener('storage',event=>{
    if(event.key===PRIMARY_KEY || event.key===LEGACY_KEY) apply();
  });

  window.addEventListener('pageshow',()=>apply());
})();
