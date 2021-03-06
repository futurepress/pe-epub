var http       = require('http');
var path       = require('path');

var _            = require('lodash');
var handlebars   = require('handlebars');
var cheerio      = require('cheerio');
var Buffers      = require('buffers');
var Q            = require('q');
var JSZip        = require('./libs/jszip.js');
var htmlEntities = require('./libs/html-entities');

var fs         = require("fs");
var mmm        = require('mmmagic');
var Magic      = mmm.Magic;

var templatesBase    = 'templates/';
var templatesDir     = __dirname + '/' + templatesBase;
// handlebars.templates = require(templatesDir + 'templates.js');
handlebars.templates = {};

var tmpls = ['container.xml', 'content.opf','page.html', 'toc.html', 'toc.ncx', 'com.apple.ibooks.display-options.xml'];
_.each(tmpls, function(tmpl){
  handlebars.templates[templatesBase + tmpl] = handlebars.compile(fs.readFileSync(templatesDir + tmpl, 'utf8'));
});

// utils
function s4() {
  return (Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1));
}

function guid() {
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

function deleteFolderRecursive(path) {
  var files = [];
  if (fs.existsSync(path)) {
    files = fs.readdirSync(path);
    files.forEach(function (file, index) {
      var curPath = path + "/" + file;
      if (fs.statSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
}

function falseString(str){
  return !str || str === '';
}

function cheerioCleanup(body){
  // self-close img tags at the last minute because they get removed by cheerio
  // valid html5 but not epub
  body = body.replace(new RegExp('(<img[^>]+)>', 'g'), '$1/>'); 

  // Text anchors should be self-closing tags <a id="bespoke" /> 
  // otherwise show up as regular, but non-functioning links in e-readers.
  body = body.replace(new RegExp('(<a[^>]+)></a>', 'g'), '$1/>');

  // self close hr
  body = body.replace(new RegExp('<hr>', 'g'), '<hr />'); 

  // self close br
  body = body.replace(new RegExp('<br>', 'g'), '<br />'); 

  // convert to entity number
  body = htmlEntities.convert(body);

  return body;
}

var readFile = Q.denodeify(fs.readFile);


/**
 *
 */
var Peepub;
Peepub = function Peepub(first, debug) {
  'use strict';

  this.json = {};
  if (first) {
    this.json = _.cloneDeep(first);
  }
  if (debug) {
    this.debug = debug;
    this.useFs = true;
  }

  this.id             = guid();
  this.requiredFields = ['title', 'cover']; // we'll take care of publish date and uuid
  this.epubFiles      = [];
  this.streams        = {};
  this.buffers        = {};
  this.assets         = {
                          css     : [],
                          js      : [],
                          assets  : []
                        };

  this.json.css = this.json.css || [];
  if (this.json.css && typeof this.json.css === 'string') {
    this.json.css = [this.json.css];
  }
  this.json.js = this.json.js || [];
  if (this.json.js && typeof this.json.js === 'string') {
    this.json.js = [this.json.js];
  }

};

Peepub.EPUB_DIR         = __dirname + '/epubs/';
Peepub.EPUB_CONTENT_DIR = 'OEBPS/'; // this is hard coded in content.opf - use handlebars if this will ever change
Peepub.EPUB_META_DIR    = 'META-INF/'; 

Peepub.prototype._handleDefaults = function () {
  var that = this;
  var d    = new Date(this.json.date || Date.now());
  if(isNaN(d.getMonth())){
    d = new Date;
  }
  var m    = d.getMonth() + 1;
  var day  = d.getDate();
  if (m.toString().length === 1) {
    m = '0' + m;
  }
  if (day.toString().length === 1) {
    day = '0' + day;
  }
  this.json.date = d.getFullYear() + '-' + m + '-' + day;
  this.json.language = this.json.language || 'en-US';

  // identifiers - can be isbn,url,uuid in that order of preference
  if (falseString(this.json.isbn) && falseString(this.json.url)) {
    this.json.uuid = this.json.uuid || guid();
    this.json.url  = null;
    this.json.isbn = null;
    this.json.id   = this.json.uuid;

  } else if (!falseString(this.json.isbn)) {
    this.json.url  = null;
    this.json.uuid = null;
    this.json.id   = this.json.isbn;

  } else if (!falseString(this.json.url)) {
    this.json.uuid = null;
    this.json.isbn = null;
    this.json.id   = this.json.url;
  }

};

Peepub.prototype._epubDir = function(){
  return (this.epubDir || Peepub.EPUB_DIR);
};

Peepub.prototype._epubPath = function(add){
  var dir = this._epubDir() + this.id + '/';
  if(add){ 
    this._epubPath();
    
    // all additions go in the content dir
    dir += Peepub.EPUB_CONTENT_DIR + add + '/';
  } 
  
  // set up the whole structure
  if(!this.useFs){
    if(_.isUndefined(this.buffers[dir + Peepub.EPUB_META_DIR + 'container.xml'] && !add)){

      this.buffers[dir + Peepub.EPUB_META_DIR + 'container.xml'] = new Buffer(handlebars.templates[templatesBase + "container.xml"]({}));
      this.epubFiles.push(dir + Peepub.EPUB_META_DIR + 'container.xml');

      var ff = this.getJson().fixedFormat;
      if( !_.isUndefined(ff) ){
        this.epubFiles.push(dir + Peepub.EPUB_META_DIR + 'com.apple.ibooks.display-options.xml');
        this.buffers[dir + Peepub.EPUB_META_DIR + 'com.apple.ibooks.display-options.xml'] = new Buffer(handlebars.templates[templatesBase + "com.apple.ibooks.display-options.xml"]({}));
      }
    }
    return dir;
  }
  
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir);
    
    // set up the whole structure
    if(!add){
      fs.mkdirSync(dir + Peepub.EPUB_META_DIR);
      fs.writeFileSync(dir + Peepub.EPUB_META_DIR + 'container.xml', handlebars.templates[templatesBase + "container.xml"]({}), "utf8");
      this.epubFiles.push(dir + Peepub.EPUB_META_DIR + 'container.xml');
      fs.mkdirSync(dir + Peepub.EPUB_CONTENT_DIR);
      fs.writeFileSync(dir + 'mimetype', 'application/epub+zip');
      this.epubFiles.push(dir + 'mimetype');

      var ff = this.getJson().fixedFormat;
      if( !_.isUndefined(ff) ){
        fs.writeFileSync(dir + Peepub.EPUB_META_DIR + 'com.apple.ibooks.display-options.xml', handlebars.templates[templatesBase + "com.apple.ibooks.display-options.xml"]({}), "utf8");
        this.epubFiles.push(dir + Peepub.EPUB_META_DIR + 'com.apple.ibooks.display-options.xml');
        this.buffers[dir + Peepub.EPUB_META_DIR + 'com.apple.ibooks.display-options.xml'] = new Buffer(handlebars.templates[templatesBase + "com.apple.ibooks.display-options.xml"]({}));
      }
    }
  } 
  return dir;
};

Peepub.prototype._fetchAssets = function(){
  this._fetchAssetsCalled = true;
  var that      = this;
  var d         = Q.defer();
  var json      = this.getJson();
  var all_pages = _.map(json.pages, function(page){ return page.body; }).join('');
  var $         = this._getDom(all_pages);
  var images    = _.filter(([json.cover]).concat(_.map($('img'), function(i){ return $(i).attr('src'); })), function(src){ return src !== ''; }); 
  var videoSrcs = [];
  var audioSrcs = [];

  _.each($('video'), function(video){
    if ($(video).attr('poster')) {
      images.push($(video).attr('poster'));
    }
    $(video).find('source').each(function(){
      videoSrcs.push($(this).attr('src'));
    });
    var inlineVideoSrc = $(video).attr('src');
    if(inlineVideoSrc){
      videoSrcs.push(inlineVideoSrc);
    }
  });
  videoSrcs = _.uniq(videoSrcs);
  images = _.uniq(images);

  _.each($('audio'), function(audio){
    $(audio).find('source').each(function(){
      audioSrcs.push($(this).attr('src'));
    });
    var inlineAudioSrc = $(audio).attr('src');
    if(inlineAudioSrc){
      audioSrcs.push(inlineAudioSrc);
    }
  });
  audioSrcs = _.uniq(audioSrcs);

  var assetPromises = _.map(_.union(videoSrcs, audioSrcs, images), function(src){
    var filePath = that._epubPath('assets') + path.basename(src);
    return that._createFile(filePath, src)
            .then(function(res){
              var asset = {
                         src : src,
                'media-type' : res.headers['content-type'],
                        href : 'assets/' + path.basename(src),
                         _id : guid()
              };
              if(src === json.cover){
                asset.properties = 'cover-image';
                asset.id = 'cover-image';
              }
              that.assets.assets.push(asset);
              return Q.fcall(function () { return true;  });
            });
  });

  Q.all(assetPromises)
    .then(function(){
      var cssPromises = _.map(json.css, function(css, i){
        var filePath = that._epubPath('styles') + 'css_' + i + '.css';
        return that._createFile(filePath, css)
                .then(function(res){
                  var asset = {
                             src : css,
                    'media-type' : 'text/css',
                            href : 'styles/' + path.basename(filePath),
                             _id : guid(),
                             id  : 'css_' + i
                  };
                  that.assets.css.unshift(asset);
                  return Q.fcall(function () { return true;  });
                });
      });
      return Q.all(cssPromises);
    })
    .then(function(){
      var jsPromises = _.map(json.js, function(js, i){
        var filePath = that._epubPath('scripts') + 'js_' + i + '.js';
        return that._createFile(filePath, js)
                .then(function(res){
                  var asset = {
                             src : js,
                    'media-type' : 'text/javascript',
                            href : 'scripts/' + path.basename(filePath),
                             _id : guid(),
                             id  : 'js_' + i
                  };
                  that.assets.js.unshift(asset);
                  return Q.fcall(function () { return true;  });
                });
      });
      return Q.all(jsPromises);
    })
    .then(function(){
      d.resolve(that.assets.assets.concat(that.assets.css).concat(that.assets.js));
    }, d.reject);
  return d.promise;
};

Peepub.prototype._getDom = function(str){
  var that = this;
  var uuid = guid();
  return cheerio.load("<div id='"+uuid+"'>" + str + '</div>', { xmlMode: true });
};


Peepub.prototype._contentOpf = function(options, callback){
  var that = this;
  var d    = Q.defer();
  var json;
  
  var opts = _.extend({
    fetchAssets : true
  }, options);
  
  if(opts.fetchAssets){
    Q.fcall(function () {
      json = that.getJson();
      return that._fetchAssets();
    })
    .then(function(assets){
      json.items = assets;

      // these tags need IDs, so we need to make them unique
      var needIs = ['creators', 'contributors', 'items'];
      _.each(needIs, function(field){
        if(that.json[field]){
          for(var i in that.json[field]){
            that.json[field][i]['i'] = parseInt(i)+1;
          }
        }
      });
      
      that._createPages(function(){
        
        json.items    = json.items.concat(that.json.pages);   // add pages to the manifest
        json.itemrefs = that.json.pages;                      // add pages to the spine
        
        that._createToc(function(){
          var contentOpf = handlebars.templates[templatesBase + "content.opf"](json);
          if(!that.useFs){
            that.buffers[that.contentOpfPath()] = new Buffer(contentOpf);
            that.epubFiles.push(that.contentOpfPath());
            d.resolve(contentOpf);

          } else {
            fs.writeFile(that.contentOpfPath(), contentOpf, function(err){
              if(err){
                d.reject('content.opf didnt save');
              } else {
                that.epubFiles.push(that.contentOpfPath());
                d.resolve(contentOpf);
              }
            });
          }
        });
      });
    }).fail(function(err){
      d.reject(err);
    });
    return d.promise;
    
  // this is used for testing
  // synchronously returns basic contentOpf
  } else {
    return handlebars.templates[templatesBase + "content.opf"](that.getJson());
  }
};

Peepub.prototype._createToc = function(callback){
  var that           = this;
  var json           = this.getJson();
  var finished_files = 0;
  
  json.tocPages = this.getTocPages();

  // by default we'll make one navpoint to their first page
  if(json.tocPages.length === 0){
    json.tocPages.push(json.pages[0]);
  }
  for(var i in json.tocPages){
    json.tocPages[i]['i'] = parseInt(i)+1;
  }
  json.items.push({
      id            : 'toc',
      href          : 'toc.html',
      'media-type'  : 'application/xhtml+xml',
      properties    : 'nav'
    });
  json.items.push({
      id            : 'ncx',
      href          : 'toc.ncx',
      'media-type'  : 'application/x-dtbncx+xml'
    });
  json.css = this.assets.css;
  
  var tocHtml = handlebars.templates[templatesBase + "toc.html"](json);
  var tocNcx = handlebars.templates[templatesBase + "toc.ncx"](json);
  this.buffers[this._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.html'] = new Buffer(tocHtml);
  this.buffers[this._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.ncx'] = new Buffer(tocNcx);

  if(this.useFs){
    fs.writeFile(this._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.html', tocHtml, function(err){
      if(err) throw 'toc.html didnt save';

      that.epubFiles.push(that._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.html');
      finished_files++;
      if(finished_files === 2){
        callback();
      }
    });
    
    fs.writeFile(this._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.ncx', tocNcx, function(err){
      if(err) throw 'toc.ncx didnt save';

      that.epubFiles.push(that._epubPath() + Peepub.EPUB_CONTENT_DIR + 'toc.ncx');
      finished_files++;
      if(finished_files === 2){
        callback();
      }
    });
  } else {
    callback();
  }
};

Peepub.prototype._getPage = function(i){
  var that         = this;
  var epubJson     = this.getJson();
  var json         = epubJson.pages[i];
  var matches;

  json.body = cheerioCleanup(json.body || '');

  // add links/script tags
  json.css         = this.assets.css;
  json.js          = this.assets.js;
  json.fixedFormat = epubJson.fixedFormat;
  return handlebars.templates[templatesBase + "page.html"](json);
  
};

// will pull it from the internet (or not) and write it
Peepub.prototype._createFile = function(dest, source, callback){
  var that = this;
  var d    = Q.defer();
  this.epubFiles.push(dest);

  // local file
  if((/^file:\/\//).test(source)){
    var file  = source.replace('file://', '');
    var magic = new Magic(mmm.MAGIC_MIME_TYPE);
    
    magic.detectFile(file, function(err, mime_type) {
      if (err){
        return d.reject(err);
      }
      
      fs.writeFile(dest, fs.readFileSync(file), function(err){
        if (err){
          return d.reject(err);
        }
        d.resolve({ headers : { 'content-type' : mime_type }, source : source });
        // callback(err, { headers : { 'content-type' : mime_type }}); // mimic http response
      });
    });
  
  // internet  
  } else if((/^https?:\/\//).test(source)){
    http.get(source, function(res){
      if(that.useFs){
        res.pipe(fs.createWriteStream(dest));
      }
      that.streams[dest] = Buffers();
      res.on('data', function(data){
        that.streams[dest].push(new Buffer(data));
      });
      res.on('end', function(err){
        if (err){
          return d.reject(err);
        }
        that.buffers[dest] = that.streams[dest].toBuffer();
        d.resolve(res);
        // callback(err, res);
        delete that.streams[dest];
      });
    });
    
  // string
  } else {
    if(this.useFs){
      fs.writeFile(dest, source, function(err){
        if (err){
          return d.reject(err);
        }
        return d.resolve({ source : source });
        // callback(err);
      });
    } else {
      this.buffers[dest] = new Buffer(source);
      d.resolve({ source : source });
      // callback();
    }
  }
  return d.promise;
};

Peepub.prototype._createPage = function(i, callback){
  var pad      = "00000";
  var name     = 'e' + (pad+i.toString()).slice(-pad.length);
  var fullpath = this._epubPath() + Peepub.EPUB_CONTENT_DIR + name + '.html';
  var that     = this;
  
  var $pageBody = cheerio.load(that.json.pages[i].body);
  // replace external assets with local
  _.each(that.assets.assets, function(ass){
    if ($pageBody("img[src='"+ass.src+"']").length > 0) {
      $pageBody("img[src='"+ass.src+"']").attr('src', ass.href);
      that.json.pages[i].body = $pageBody.html();
    }
    if ($pageBody("video").length > 0) {
      if($pageBody("video[poster='"+ass.src+"']")[0]){
        $pageBody("video[poster='"+ass.src+"']").attr('poster', ass.href);
      }
      if($pageBody("video[src='"+ass.src+"']")[0]){
        $pageBody("video[src='"+ass.src+"']").attr('src', ass.href);
      }
      if($pageBody("source[src='"+ass.src+"']")[0]){
        $pageBody("source[src='"+ass.src+"']").attr('src', ass.href);
      }
      that.json.pages[i].body = $pageBody.html();
    }

    if ($pageBody("audio").length > 0) {
      if($pageBody("audio[src='"+ass.src+"']")[0]){
        $pageBody("audio[src='"+ass.src+"']").attr('src', ass.href);
      }
      if($pageBody("source[src='"+ass.src+"']")[0]){
        $pageBody("source[src='"+ass.src+"']").attr('src', ass.href);
      }
      that.json.pages[i].body = $pageBody.html();
    }

  });

  // remove name attrs from a tags - invalid
  if($pageBody('a[name]').length > 0){
    $pageBody('a[name]').each(function(){
      var name = $pageBody(this).attr('name');
      if(!$pageBody(this).attr('id')){
        $pageBody(this).attr('id', name);
      }
      $pageBody(this).attr('name', null);
    }) 
    that.json.pages[i].body = $pageBody.html();
  }
  
  this._createFile(fullpath, this._getPage(i))
    .then(function(res){
      
      // prep page for manifest + addtn'l info
      that.json.pages[i].path          = fullpath;
      that.json.pages[i].id            = name;
      that.json.pages[i].href          = name + '.html';
      that.json.pages[i]['media-type'] = 'application/xhtml+xml';
      if(that.json.js.length > 0){
        that.json.pages[i]['properties'] = 'scripted';
      }
      
      callback(fullpath);

    }, function(err){
      throw filename + ' didnt save';
    });
};

Peepub.prototype._createPages = function(callback){
  if(!this._fetchAssetsCalled) throw "_fetchAssets needs to be called before _createPages";
  
  var that = this;
  _.each(this.getJson().pages, function(page, i){
    that._createPage(i, function(){
      if(_.filter(that.json.pages, function(p){ return(!!p.id); }).length === that.json.pages.length){
        callback();
      }
    });
  })
};

Peepub.prototype._zip = function(callback){
  var zip  = new JSZip();
  var d    = Q.defer();
  var that = this;
  var dir  = this._epubPath().slice(0,-1);
  
  var epubPath = that.fileName ? that._epubDir() + that.fileName  : that._epubDir() + that.id + '.epub';

  // mimetype must be first
  if(this.useFs){
    var filteredData = _.filter(this.epubFiles, function(fileObj){
      if(typeof fileObj === 'string'){
        fileObj = {
          name : fileObj.replace(dir, "").substr(1),
          path : fileObj
        }
      }
      if(fileObj.name === 'mimetype'){
        zip.file(fileObj.name, fs.readFileSync(fileObj.path, 'binary'), { binary : true });
        return false;
      }
      return true;
    });
    
  } else {
    var buff = new Buffer('application/epub+zip');
    zip.file('mimetype', buff.toString('base64'), { base64 : true });
    var filteredData = this.epubFiles;
  }
  
  var finished = 0;
  function is_finished(){
    finished += 1;
    if(finished === filteredData.length){

      if(that.useFs){
        fs.writeFile(epubPath, zip.generate({base64:false}), 'binary', function(err){
          that.epubFile = epubPath;
          callback(null, epubPath);
        });

      } else {
        callback(null, zip.generate());        
      }
    }
  }

  _.each(filteredData, function(fileObj){
    if(typeof fileObj === 'string'){
      fileObj = {
        name : fileObj.replace(dir, "").substr(1),
        path : fileObj
      }
    }
    if(_.isUndefined(that.buffers[fileObj.path])){
      fs.readFile(fileObj.path, 'binary', function(err, data){
        zip.file(fileObj.name, data, { binary : true });

        is_finished();
      });

    } else {
      zip.file(fileObj.name, that.buffers[fileObj.path].toString('base64'), { base64 : true });
      is_finished();
    }
  });

  // var filteredDataPromises = _.map(filteredData, function(fileObj){
  //   if(typeof fileObj === 'string'){
  //     fileObj = {
  //       name : fileObj.replace(dir, "").substr(1),
  //       path : fileObj
  //     }
  //   }
  //   if(_.isUndefined(that.buffers[fileObj.path])){
  //     console.log(fileObj.path);
  //     return Q.nfcall(fs.readFile, fileObj.path, 'binary').then(function(data){
  //       console.log('hi');
  //       zip.file(fileObj.name, data, { binary : true });
  //       return Q.fcall(function () { return true;  });

  //     }, function(err){
  //       console.log(err);
  //     });

  //   } else {
  //     zip.file(fileObj.name, that.buffers[fileObj.path].toString('base64'), { base64 : true });
  //     return Q.fcall(function () { return true;  });

  //   }
  // });

  // Q.all(filteredDataPromises)
  //   .then(function(){
  //     if(that.useFs){
  //       fs.writeFile(epubPath, zip.generate({base64:false}), 'binary', function(err){
  //         that.epubFile = epubPath;
  //         d.resolve(epubPath);
  //       });

  //     } else {
  //       d.resolve(zip.generate());        
  //     }
  //   }).done();
  // return d.promise;
  
};


// PUBLIC //

Peepub.prototype.getJson = function(){
  var that = this;
  this._handleDefaults();
  
  // we want these to be arrays, but we'll be nice to people
  var oneToMany = ['subject', 'publisher', 'creator', 'contributor', 'language'];
  _.each(oneToMany, function _oneToMany(field){
    if(that.json[field] && !that.json[field + 's']){
      that.json[field + 's'] = [that.json[field]];
    }
    if(that.json[field + 's'] && that.json[field + 's'].length === 1 && that.json[field + 's'][0] === ''){
      delete that.json[field + 's'];
    }
  });

  // required fields
  _.each(this.requiredFields, function(field){
    if(!that.json[field]) throw "Missing a required field: " + field;
  });

  // fixed format required fields
  if( !_.isUndefined(this.json.fixedFormat) ){
    if( _.isUndefined(this.json.fixedFormat.w) || _.isUndefined(this.json.fixedFormat.h) ){
      throw "Fixed format epubs must define width and height: w,h";
    }
    if( !this.json.fixedFormat._loaded ){
      this.json.css.unshift("body { width: "+parseInt(this.json.fixedFormat.w)+"px;height: "+parseInt(this.json.fixedFormat.h)+"px;margin: 0; }");
      this.json.fixedFormat._loaded = true;
    }
  }

  // local pages
  if( !this._checkedForLocalPages ){
    this._checkedForLocalPages = true;
    _.each(that.json.pages, function(page, i){
      // read local files for pe-eps
      if((/^file:\/\//).test(page.body)){
        var $ = cheerio.load(fs.readFileSync(page.body.replace('file://', ''), 'utf8'));
        that.json.pages[i].body = $('body').html();
      }
    });
  }
  
  // modified - 2013-03-20T12:00:00Z
  var utc = new Date((new Date).toUTCString());
  function _pad(a){
    return a.toString().length === 1 ? '0' + a.toString() : a;
  }
  this.json.modified =  utc.getFullYear() + '-' + 
                        _pad(utc.getMonth() + 1) + '-' +
                        _pad(utc.getDate()) + 'T' + 
                        _pad(utc.getHours() + 1) + ':' + 
                        _pad(utc.getMinutes() + 1) + ':' + 
                        _pad(utc.getSeconds() + 1) + 'Z';


  return this.json;
};

Peepub.prototype.set = function(key, val){
  this.json[key] = val;
};

Peepub.prototype.clean = function(){
  deleteFolderRecursive(this._epubPath());
  if (fs.existsSync(this.epubFile)) {
    fs.unlinkSync(this.epubFile);
  }
};

Peepub.prototype.create = function(options, callback){
  var that = this;
  var d    = Q.defer();
  
  if (arguments.length === 1 && typeof options === 'function'){
    callback = options;
    options = {};

  } else if(typeof options === 'string') {
    var tmp = {};
    if(options.match(/\.epub$/)){
      tmp.epubDir = path.dirname(options) + '/';
      this.fileName = path.basename(options);
    } else {
      tmp.epubDir = options.replace(/\/$/, '') + '/';
    }
    this.useFs = true;
    options = tmp;
  }
  
  var opts = _.extend({
    epubDir : null,
    zip : true
  }, options);


  if(opts.epubDir) {
    this.epubDir = opts.epubDir;
  }
  this._contentOpf()
  .then(function() {
    if(opts.zip) {
      that._zip(function(err, epubPath) {
        if(callback){
          callback(err, epubPath);
        }
        if(err){
          d.reject(err);
        } else {
          d.resolve(epubPath);
        }
      });
      
    } else {
      if(callback){
        callback(null, that._epubPath());
      }
      d.resolve(that._epubPath());
    }
  })
  .fail(function(err){
    d.reject(err);
  }).done();
  return d.promise;
};

Peepub.prototype.contentOpfPath = function(){
  if(!this.id) throw "This epub has not been created yet";
  return this._epubPath() + Peepub.EPUB_CONTENT_DIR + 'content.opf';
};

Peepub.prototype.getTocPages = function(){
  return _.filter(this.getJson().pages, function(page){ return page.toc; });
};

module.exports = Peepub;