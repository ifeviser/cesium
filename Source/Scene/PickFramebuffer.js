import BoundingRectangle from "../Core/BoundingRectangle.js";
import Color from "../Core/Color.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import PassState from "../Renderer/PassState.js";
import Renderbuffer from "../Renderer/Renderbuffer.js";
import RenderbufferFormat from "../Renderer/RenderbufferFormat.js";
import Texture from "../Renderer/Texture.js";

/**
 * @private
 */
function PickFramebuffer(context) {
  // Override per-command states
  var passState = new PassState(context);
  passState.blendingEnabled = false;
  passState.scissorTest = {
    enabled: true,
    rectangle: new BoundingRectangle(),
  };
  passState.viewport = new BoundingRectangle();

  this._context = context;
  this._fb = undefined;
  this._passState = passState;
  this._width = 0;
  this._height = 0;
}
PickFramebuffer.prototype.begin = function (screenSpaceRectangle, viewport) {
  var context = this._context;
  var width = viewport.width;
  var height = viewport.height;

  BoundingRectangle.clone(
    screenSpaceRectangle,
    this._passState.scissorTest.rectangle
  );

  // Initially create or recreate renderbuffers and framebuffer used for picking
  if (!defined(this._fb) || this._width !== width || this._height !== height) {
    this._width = width;
    this._height = height;

    this._fb = this._fb && this._fb.destroy();
    this._fb = new Framebuffer({
      context: context,
      colorTextures: [
        new Texture({
          context: context,
          width: width,
          height: height,
        }),
      ],
      depthStencilRenderbuffer: new Renderbuffer({
        context: context,
        width: width,
        height: height,
        format: RenderbufferFormat.DEPTH_STENCIL,
      }),
    });
    this._passState.framebuffer = this._fb;
  }

  this._passState.viewport.width = width;
  this._passState.viewport.height = height;

  return this._passState;
};

var colorScratch = new Color();

PickFramebuffer.prototype.end = function (screenSpaceRectangle) {
  var width = defaultValue(screenSpaceRectangle.width, 1.0);
  var height = defaultValue(screenSpaceRectangle.height, 1.0);

  var context = this._context;
  var pixels = context.readPixels({
    x: screenSpaceRectangle.x,
    y: screenSpaceRectangle.y,
    width: width,
    height: height,
    framebuffer: this._fb,
  });

  var max = Math.max(width, height);
  var length = max * max;
  var halfWidth = Math.floor(width * 0.5);
  var halfHeight = Math.floor(height * 0.5);

  var x = 0;
  var y = 0;
  var dx = 0;
  var dy = -1;

  // Spiral around the center pixel, this is a workaround until
  // we can access the depth buffer on all browsers.

  // The region does not have to square and the dimensions do not have to be odd, but
  // loop iterations would be wasted. Prefer square regions where the size is odd.
  for (var i = 0; i < length; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      var index = 4 * ((halfHeight - y) * width + x + halfWidth);

      colorScratch.red = Color.byteToFloat(pixels[index]);
      colorScratch.green = Color.byteToFloat(pixels[index + 1]);
      colorScratch.blue = Color.byteToFloat(pixels[index + 2]);
      colorScratch.alpha = Color.byteToFloat(pixels[index + 3]);

      var object = context.getObjectByPickColor(colorScratch);
      if (defined(object)) {
        return object;
      }
    }

    // if (top right || bottom left corners) || (top left corner) || (bottom right corner + (1, 0))
    // change spiral direction
    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      var temp = dx;
      dx = -dy;
      dy = temp;
    }

    x += dx;
    y += dy;
  }

  return undefined;
};

PickFramebuffer.prototype.endBulkRect = function (screenSpaceRectangle) {
  var pickedObjects = [];
  var width = defaultValue(screenSpaceRectangle.width, 1.0);
  var height = defaultValue(screenSpaceRectangle.height, 1.0);

  var context = this._context;
  var pixels = context.readPixels({
    x: screenSpaceRectangle.x,
    y: screenSpaceRectangle.y,
    width: width,
    height: height,
    framebuffer: this._fb,
  });
  var size = width * height;
  // create pallete buffer
  var colors32 = new Uint32Array(context._nextPickColor[0]);
  // current pos of palette entry
  var palettePos = colors32.length - 1; // Start from top as this will speed up indexOf function
  // pixel data as 32 bit words so you can handle a pixel at a time rather than bytes.
  var imgData = new Uint32Array(pixels.buffer);

  // hold the color. If the images are low colour (less 256) it is highly probable that many pixels will
  // be the same as the previous. You can avoid the index search if this is the case.
  var color = (colors32[palettePos--] = imgData[0]); // assign first pixels to ease logic in loop
  for (var i = 1; i < size && palettePos >= 0; i += 1) {
    // loop till al pixels read if palette full
    if (color !== imgData[i]) {
      // is different than previouse
      if (colors32.indexOf(imgData[i], palettePos) === -1) {
        // is in the pallet
        color = colors32[palettePos--] = imgData[i]; // add it
      }
    }
  }
  for (var i = colors32.length - 1; i >= palettePos; i--) {
    var object = context.getObjectByPickColor(
      Cesium.Color.fromRgba(colors32[i])
    );
    if (defined(object)) {
      pickedObjects.push(object);
    }
  }
  if (pickedObjects.length > 0) return pickedObjects;
  return undefined;
};

PickFramebuffer.prototype.endBulk = function (
  screenSpaceRectangle,
  drawingBufferPositions
) {
  var pickedObjects = [];
  var width = defaultValue(screenSpaceRectangle.width, 1.0);
  var height = defaultValue(screenSpaceRectangle.height, 1.0);

  var context = this._context;
  var pixels = context.readPixels({
    x: screenSpaceRectangle.x,
    y: screenSpaceRectangle.y,
    width: width,
    height: height,
    framebuffer: this._fb,
  });
  var colors32 = new Uint32Array(context._nextPickColor[0]);
  // current pos of palette entry
  var palettePos = colors32.length - 1; // Start from top as this will speed up indexOf function

  var imgData = new Uint32Array(pixels.buffer);

  //console.log(screenSpaceRectangle,width,height, imgData.length);
  var pickedObjects = [];
  var prevColor;
  drawingBufferPositions.forEach(function (dp) {
    var x = Math.round(dp.center.x);
    var y = Math.round(dp.center.y);
    var diffX = Math.round(dp.diff.x);
    var diffY = Math.round(dp.diff.y);
    for (var i = -diffX; i <= diffX - 10; i += 10) {
      for (var j = -diffY; j <= diffY - 10; j += 10) {
        var color = imgData[(height - (y + i)) * width + (x + j)];
        if (color != prevColor) {
          if (colors32.indexOf(color, palettePos) === -1) {
            // is not in the pallet
            prevColor = colors32[palettePos--] = color; // add it
          }
        }
      }
    }
  });
  for (var i = colors32.length - 1; i >= palettePos; i--) {
    var object = context.getObjectByPickColor(
      Cesium.Color.fromRgba(colors32[i])
    );
    if (defined(object)) {
      pickedObjects.push(object);
    }
  }
  if (pickedObjects.length > 0) return pickedObjects;
  return undefined;
};

PickFramebuffer.prototype.isDestroyed = function () {
  return false;
};

PickFramebuffer.prototype.destroy = function () {
  this._fb = this._fb && this._fb.destroy();
  return destroyObject(this);
};
export default PickFramebuffer;
