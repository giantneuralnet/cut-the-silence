import {MotionAnalyzer,trackCPU,soften,WIDTH,HEIGHT,COLS,ROWS} from './motion.mjs';
// One fragment tracks one patch. R32F input and RGBA32F output preserve the
// same normalized-correlation arithmetic as the CPU fallback.
export function createMotionAnalyzer() {
  let gl,program,target,framebuffer,vao,textures=[],shaders=[];
  const dispose=()=>{
    if(!gl)return;
    for(const t of [...textures,target])if(t)gl.deleteTexture(t);
    for(const s of shaders)gl.deleteShader(s);
    if(program)gl.deleteProgram(program);if(framebuffer)gl.deleteFramebuffer(framebuffer);if(vao)gl.deleteVertexArray(vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();gl=null;
  };
  try {
    const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(COLS,ROWS):document.createElement('canvas');
    canvas.width=COLS;canvas.height=ROWS;
    gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,preserveDrawingBuffer:false});
    if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw new Error('No floating-point WebGL render target.');
    const compile=(type,source)=>{const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
    program=gl.createProgram();
    gl.attachShader(program,compile(gl.VERTEX_SHADER,`#version 300 es
    void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`#version 300 es
    precision highp float;
    uniform highp sampler2D a; uniform highp sampler2D b; uniform highp sampler2D c; uniform highp sampler2D d;
    out vec4 result;
    float correlation(highp sampler2D first,highp sampler2D second,ivec2 p,ivec2 offset){
      float sa=0.,sb=0.,aa=0.,bb=0.,ab=0.;
      for(int y=-3;y<=3;y++)for(int x=-3;x<=3;x++){
        float u=texelFetch(first,p+ivec2(x,y),0).r,v=texelFetch(second,p+ivec2(x,y)+offset,0).r;
        sa+=u;sb+=v;aa+=u*u;bb+=v*v;ab+=u*v;
      }
      float va=aa-sa*sa/49.,vb=bb-sb*sb/49.;
      if(va<.0049||vb<.0049)return -1.;
      return (ab-sa*sb/49.)/sqrt(va*vb);
    }
    void main(){
      ivec2 p=ivec2(gl_FragCoord.xy)*8+8;
      float zero=correlation(a,b,p,ivec2(0));
      if(zero<.975)zero=max(zero,max(correlation(c,b,p,ivec2(0)),correlation(a,d,p,ivec2(0))));
      float best=zero;ivec2 displacement=ivec2(0);
      if(zero<.975)for(int y=-3;y<=3;y++)for(int x=-3;x<=3;x++){
        float s=correlation(a,b,p,ivec2(x,y));if(s>best+.000001){best=s;displacement=ivec2(x,y);}
      }
      result=vec4(vec2(displacement),best,zero);
    }`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const texture=()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);return t;};
    textures=[texture(),texture(),texture(),texture()];
    for(let i=0;i<4;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,WIDTH,HEIGHT,0,gl.RED,gl.FLOAT,null);gl.uniform1i(gl.getUniformLocation(program,['a','b','c','d'][i]),i);}
    target=texture();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,COLS,ROWS,0,gl.RGBA,gl.FLOAT,null);
    framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete motion framebuffer.');
    gl.viewport(0,0,COLS,ROWS);
    const detector=new MotionAnalyzer((a,b)=>{
      try {
        if(!gl||gl.isContextLost())throw new Error('Motion context lost.');
        for(const [i,data] of [a,b,soften(a),soften(b)].entries()){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,WIDTH,HEIGHT,gl.RED,gl.FLOAT,data);}
        gl.drawArrays(gl.TRIANGLES,0,3);
        const result=new Float32Array(COLS*ROWS*4);gl.readPixels(0,0,COLS,ROWS,gl.RGBA,gl.FLOAT,result);
        if(gl.getError()!==gl.NO_ERROR)throw new Error('Motion readback failed.');
        return result;
      }catch{dispose();detector.processing='cpu';detector.track=trackCPU;return trackCPU(a,b);}
    });
    detector.processing='webgl';detector.dispose=dispose;return detector;
  }catch{dispose();return new MotionAnalyzer();}
}
