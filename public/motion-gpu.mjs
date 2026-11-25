import {MotionAnalyzer,differenceCPU,WIDTH,HEIGHT,COLS,ROWS} from './motion.mjs?v=4';
// Each fragment sums fixed-position RGB differences within one 16x16 tile.
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
    uniform highp sampler2D a; uniform highp sampler2D b;
    uniform vec3 offset;
    out vec4 result;
    void main(){
      ivec2 origin=ivec2(gl_FragCoord.xy)*8;float sum=0.;
      for(int y=0;y<16;y++)for(int x=0;x<16;x++){
        ivec2 p=origin+ivec2(x,y);
        vec3 change=abs(texelFetch(b,p,0).rgb-texelFetch(a,p,0).rgb-offset);
        sum+=max(0.,max(change.r,max(change.g,change.b))-3./255.);
      }
      result=vec4(sum*100./256.,0.,0.,1.);
    }`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const texture=()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);return t;};
    textures=[texture(),texture()];
    for(let i=0;i<2;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,WIDTH,HEIGHT,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.uniform1i(gl.getUniformLocation(program,['a','b'][i]),i);}
    target=texture();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,COLS,ROWS,0,gl.RGBA,gl.FLOAT,null);
    framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete motion framebuffer.');
    gl.viewport(0,0,COLS,ROWS);
    const detector=new MotionAnalyzer((a,b,offset)=>{
      try {
        if(!gl||gl.isContextLost())throw new Error('Motion context lost.');
        for(const [i,data] of [a,b].entries()){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,WIDTH,HEIGHT,gl.RGBA,gl.UNSIGNED_BYTE,data);}
        gl.uniform3f(gl.getUniformLocation(program,'offset'),...offset.map(v=>v/255));
        gl.drawArrays(gl.TRIANGLES,0,3);
        const result=new Float32Array(COLS*ROWS*4);gl.readPixels(0,0,COLS,ROWS,gl.RGBA,gl.FLOAT,result);
        if(gl.getError()!==gl.NO_ERROR)throw new Error('Motion readback failed.');
        return Float32Array.from({length:COLS*ROWS},(_,i)=>result[i*4]);
      }catch{dispose();detector.processing='cpu';detector.compare=differenceCPU;return differenceCPU(a,b,offset);}
    });
    detector.processing='webgl';detector.dispose=dispose;return detector;
  }catch{dispose();return new MotionAnalyzer();}
}
