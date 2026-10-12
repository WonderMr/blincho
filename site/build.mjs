import {readFile, writeFile, mkdir, cp, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'site');
const output = path.join(root, 'site-dist');
const languages = ['en','ru','es','fr','de','it','pt','zh','ja','ko','ar','hi','tr','pl','uk'];
const htmlLocales = {pt:'pt-BR', zh:'zh-CN'};
const config = JSON.parse(await readFile(path.join(source, 'config.json'), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
if (config.origin !== 'https://blincho.app' || config.repository !== 'WonderMr/blincho') throw new Error('Unexpected site origin or repository');
if (config.donationUrl && !/^https:\/\/www\.buymeacoffee\.com\/[\w-]+\/?$|^https:\/\/buymeacoffee\.com\/[\w-]+\/?$/.test(config.donationUrl)) throw new Error('Invalid donation URL');
const template = await readFile(path.join(source, 'index.html'), 'utf8');
const en = JSON.parse(await readFile(path.join(source, 'locales/en.json'), 'utf8'));
let manifest;
try { manifest=JSON.parse(await readFile(path.join(source, 'releases.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; manifest={schemaVersion:1, releases:[], latest:null}; }
if (!Array.isArray(manifest.releases)) throw new Error('Invalid release manifest');
const releaseUrl = value => {
  const url = new URL(value);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${config.repository}/releases/`)) throw new Error('Unexpected release URL');
  return escape(url.href);
};
const latest=manifest.releases.find(r=>r.version===manifest.latest);
await rm(output, {recursive:true,force:true});
await mkdir(path.join(output,'assets'), {recursive:true});
await cp(path.join(root,'assets/icon.png'),path.join(output,'assets/icon.png'));
for (const file of ['style.css','site.js']) await cp(path.join(source,file),path.join(output,file));
for (const lang of languages) {
  const catalog=JSON.parse(await readFile(path.join(source,`locales/${lang}.json`),'utf8'));
  const keys=Object.keys(en).sort();
  if (JSON.stringify(keys)!==JSON.stringify(Object.keys(catalog).sort())) throw new Error(`Locale key mismatch: ${lang}`);
  for (const [key,text] of Object.entries(catalog)) {
    if (typeof text!=='string' || !text.trim() || /[\u2014\u2015]|\s\u2013\s/.test(text)) throw new Error(`Invalid copy: ${lang}/${key}`);
  }
  const t=key=>{if (!Object.hasOwn(catalog,key)) throw new Error(`Missing ${lang}/${key}`);return escape(catalog[key]);};
  let html=template.replace(/(<[^>]+\bdata-i18n="([^"]+)"[^>]*>)[^<]*(<\/[^>]+>)/g,(_,open,key,close)=>open+t(key)+close);
  for (const attr of ['aria-label','alt','content','title']) {
    html=html.replace(new RegExp(`<[^>]+data-i18n-${attr}="([^"]+)"[^>]*>`, 'g'), (tag,key)=>{
      const pattern=new RegExp(`(?<![\\w-])${attr}="[^"]*"`);
      return pattern.test(tag)?tag.replace(pattern,`${attr}="${t(key)}"`):tag.replace(/>$/,` ${attr}="${t(key)}">`);
    });
  }
  html=html.replace(/<html[^>]*>/,`<html lang="${htmlLocales[lang]||lang}" dir="${lang==='ar'?'rtl':'ltr'}">`);
  html=html.replace(/<\/head>/,`<link rel="canonical" href="${config.origin}/${lang}/">\n${languages.map(l=>`<link rel="alternate" hreflang="${htmlLocales[l]||l}" href="${config.origin}/${l}/">`).join('\n')}\n<link rel="alternate" hreflang="x-default" href="${config.origin}/">\n<meta property="og:title" content="${t('meta.title')}"><meta property="og:description" content="${t('meta.description')}"><meta property="og:image" content="${config.origin}/assets/icon.png"><meta property="og:url" content="${config.origin}/${lang}/"><meta property="og:type" content="website"></head>`);
  html=html.replace(/(<button[^>]+id="theme-toggle")/,`$1 data-system="${t('control.theme.system')}" data-light="${t('control.theme.light')}" data-dark="${t('control.theme.dark')}"`);
  html=html.replace(new RegExp(`(<option value="${lang}")`),'$1 selected');
  html=html.replace(/(<[^>]+id="release-version"[^>]*>)[^<]*/,`$1${latest?escape(latest.version):t('download.preparing')}`);
  if(latest){
    html=html.replace(/(<(?:time|span)[^>]+id="release-date")([^>]*>)[^<]*/,(_,open,attrs)=>`${open}${attrs.replace(/\s+hidden\b/,'')}${escape(new Intl.DateTimeFormat(htmlLocales[lang]||lang,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(latest.publishedAt)))}`);
  }
  html=html.replace(/(<div[^>]+data-download-platform="([^"]+)"[^>]*>)[\s\S]*?(<\/div>)/g,(_,open,platform,close)=>{
    const assets=latest?.assets.filter(a=>a.platform===platform)||[];
    const links=assets.map(a=>{
      if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<=0)throw new Error('Invalid download metadata');
      const arch=platform==='macos'?(a.architecture==='arm64'?'Apple silicon':'Intel'):(a.architecture==='arm64'?'ARM64':'x64');
      return `<a class="download-file" href="${releaseUrl(a.url)}"><span class="download-file-label">${arch} · ${escape(a.format)}</span><span class="download-file-detail">${t(a.kind==='installer'?'download.installer':'download.portable')} · ${(a.size/1048576).toFixed(1)} MB ↗</span></a>`;
    }).join('');
    return open+(links||`<p>${t('download.preparing')}</p>`)+close;
  });
  const history=manifest.releases.map(r=>`<article class="release-entry"><h3><a href="${releaseUrl(r.url)}">${escape(r.version)}</a></h3>${catalog[`release.${r.version}`]?`<p>${t(`release.${r.version}`)}</p>`:''}<a href="${releaseUrl(r.url)}">${t('changelog.more')} ↗</a>${r.checksumUrl?` · <a href="${releaseUrl(r.checksumUrl)}">${t('download.checksums')}</a>`:''}</article>`).join('');
  html=html.replace(/(<div[^>]+id="changelog-list"[^>]*>)[\s\S]*?(<\/div>)/,`$1${history}$2`);
  if(config.donationUrl) html=html.replace(/<a\b[^>]*id="donation-link"[^>]*>/,tag=>{
    tag=tag.replace(/\s+hidden\b/,'');
    return /\bhref=/.test(tag)?tag.replace(/href="[^"]*"/,`href="${escape(config.donationUrl)}"`):tag.replace(/>$/,` href="${escape(config.donationUrl)}">`);
  });
  const privacy=`<section id="privacy" class="privacy-section section-shell"><h2>${t('privacy.title')}</h2><p>${t('privacy.body')}</p></section>`;
  html=html.replace('</main>',privacy+'</main>');
  html=html.replace('</footer>',`<nav class="legal-links"><a href="#privacy">${t('footer.privacy')}</a><a href="https://github.com/${config.repository}/issues">${t('footer.contact')}</a></nav></footer>`);
  await mkdir(path.join(output,lang),{recursive:true});
  await writeFile(path.join(output,lang,'index.html'),html);
  if(lang==='en')await writeFile(path.join(output,'index.html'),html);
}
await writeFile(path.join(output,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`);
await writeFile(path.join(output,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${languages.map(l=>`<url><loc>${config.origin}/${l}/</loc></url>`).join('')}</urlset>`);
await writeFile(path.join(output,'releases.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(output,'404.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><title>Blincho: 404</title><body><h1>404</h1><a href="/">Blincho</a></body></html>');
console.log(`Built ${languages.length} language pages; ${manifest.releases.length} releases.`);
