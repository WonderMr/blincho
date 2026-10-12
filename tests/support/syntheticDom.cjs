const fs = require('fs');
const vm = require('vm');
const repo = require('node:path').resolve(__dirname, '../..');
const repoRequire = require('module').createRequire(repo+'/package.json');
const transformer = repoRequire('rolldown/utils');
class DOMNode {
  constructor(name, ownerDocument, type=1) {this.nodeName=name.toUpperCase();this.tagName=this.nodeName;this.nodeType=type;this.ownerDocument=ownerDocument;this.childNodes=[];this.parentNode=null;this.namespaceURI='http://www.w3.org/1999/xhtml';this.attributes={};this.style={setProperty:(k,v)=>{this.style[k]=v},removeProperty:()=>{}};}
  appendChild(n){if(n.parentNode)n.parentNode.removeChild(n);this.childNodes.push(n);n.parentNode=this;return n}
  insertBefore(n,b){if(n.parentNode)n.parentNode.removeChild(n);const i=this.childNodes.indexOf(b);if(i<0)return this.appendChild(n);this.childNodes.splice(i,0,n);n.parentNode=this;return n}
  removeChild(n){const i=this.childNodes.indexOf(n);if(i>=0)this.childNodes.splice(i,1);n.parentNode=null;return n}
  setAttribute(k,v){this.attributes[k]=String(v)} removeAttribute(k){delete this.attributes[k]}
  setAttributeNS(ns,k,v){this.setAttribute(k,v)} removeAttributeNS(ns,k){this.removeAttribute(k)}
  getAttribute(k){return this.attributes[k] ?? null}
  addEventListener(name,callback){this._listeners??=new Map();if(!this._listeners.has(name))this._listeners.set(name,new Set());this._listeners.get(name).add(callback)}
  removeEventListener(name,callback){this._listeners?.get(name)?.delete(callback)}
  dispatchEvent(event){for(const callback of this._listeners?.get(event.type)||[])callback(event)}
  focus(){this.ownerDocument.activeElement=this}
  get isConnected(){let node=this;while(node.parentNode)node=node.parentNode;return node.nodeType===9}
  matches(selector){return selector.split(',').some(value=>{let s=value.trim();const noDisabled=/:not\((?:\[disabled\]|:disabled)\)/.test(s);s=s.replace(/:not\((?:\[disabled\]|:disabled)\)/,'');if(noDisabled&&(this.disabled||this.getAttribute('disabled')!==null))return false;const tag=s.match(/^[a-z]+/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;for(const match of s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)){const actual=this.getAttribute(match[1]);if(actual===null||(match[2]!==undefined&&actual!==match[2]))return false}return Boolean(tag||s.startsWith('['))})}
  querySelectorAll(selector){const result=[];const visit=node=>{for(const child of node.childNodes){if(child.nodeType===1&&child.matches(selector))result.push(child);visit(child)}};visit(this);return result}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null}
  get options(){return this.childNodes.filter(node=>node.tagName==='OPTION')}
  get value(){return this._value??this.attributes.value??''} set value(value){this._value=value}
  closest(selector){let node=this;while(node&&node.nodeType===1){if(node.matches(selector))return node;node=node.parentNode}return null}
  getContext(){return null} getBoundingClientRect(){return {x:0,y:0,width:400,height:300}}
  get firstChild(){return this.childNodes[0]||null} get lastChild(){return this.childNodes.at(-1)||null}
  get nextSibling(){return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]||null}
  set textContent(t){this.childNodes=[];this._text=String(t)} get textContent(){return this.nodeType===3?this.nodeValue:this._text||this.childNodes.map(n=>n.textContent).join('')}
  contains(n){return n===this||this.childNodes.some(c=>c.contains(n))}
}
const doc = new DOMNode('#document',null,9);doc.ownerDocument=doc;
doc.createElement=n=>new DOMNode(n,doc);doc.createElementNS=(ns,n)=>{const e=new DOMNode(n,doc);e.namespaceURI=ns;return e};
doc.createTextNode=t=>{const e=new DOMNode('#text',doc,3);e.nodeValue=t;e._text=t;return e};
doc.documentElement=doc.createElement('html');doc.body=doc.createElement('body');doc.activeElement=doc.body;
doc.appendChild(doc.documentElement);doc.documentElement.appendChild(doc.body);
global.window={document:doc,HTMLIFrameElement:class {},HTMLElement:DOMNode,Node:DOMNode,event:undefined,addEventListener(){},removeEventListener(){}};
window.localStorage={getItem:key=>key==='blincho-language-v1'?JSON.stringify({preference:'ru',acknowledged:true}):null,setItem(){},removeItem(){}};
global.document=doc;global.HTMLElement=DOMNode;global.Node=DOMNode;global.navigator={userAgent:'review'};
const React = repoRequire('react');
const ReactDOMClient = repoRequire('react-dom/client');
const ReactDOM = repoRequire('react-dom');

module.exports={React,ReactDOMClient,ReactDOM,doc,DOMNode,transformer};
