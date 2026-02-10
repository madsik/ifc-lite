/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-based object picking
 */

import { WebGPUDevice } from './device.js';
import type { Mesh, PickResult, Mat4 } from './types.js';

export interface PickDrawable {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  firstIndex: number;
  baseVertex: number;
  transform: Mat4;
  expressId: number;
  modelIndex?: number;
}

export class Picker {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private depthTexture: GPUTexture;
  private colorTexture: GPUTexture;
  private uniformBuffer: GPUBuffer;
  private expressIdBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private maxMeshes: number = 100000; // Support up to 100K meshes (was 10K)

  constructor(device: WebGPUDevice, width: number = 1, height: number = 1) {
    this.device = device.getDevice();

    // Create textures for picking
    this.colorTexture = this.device.createTexture({
      size: { width, height },
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Create uniform buffer for viewProj + model matrices (32 floats = 128 bytes)
    this.uniformBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create storage buffer for expressIds (one u32 per mesh, +1 encoding)
    // We'll upload all expressIds at once, then use instance_index to look them up
    this.expressIdBuffer = this.device.createBuffer({
      size: this.maxMeshes * 4, // 4 bytes per u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create picker shader that uses storage buffer for per-object expressId
    const shaderModule = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          model: mat4x4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<storage, read> expressIds: array<u32>;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.viewProj * uniforms.model * vec4<f32>(input.position, 1.0);
          // Look up expressId from storage buffer using instance index
          output.objectId = expressIds[instanceIndex];
          return output;
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          return input.objectId;
        }
      `,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'r32uint' }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reverse-Z: greater instead of less
      },
    });

    // Create bind group using the pipeline's auto-generated layout
    // IMPORTANT: Must use getBindGroupLayout() when pipeline uses layout: 'auto'
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.expressIdBuffer },
        },
      ],
    });
  }

  /**
   * Pick object at screen coordinates
   * Returns PickResult with expressId and modelIndex for multi-model support
   */
  async pick(
    x: number,
    y: number,
    width: number,
    height: number,
    drawables: PickDrawable[],
    viewProj: Float32Array
  ): Promise<PickResult | null> {
    // Resize textures if needed
    if (this.colorTexture.width !== width || this.colorTexture.height !== height) {
      this.colorTexture.destroy();
      this.depthTexture.destroy();

      this.colorTexture = this.device.createTexture({
        size: { width, height },
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      this.depthTexture = this.device.createTexture({
        size: { width, height },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    
    // Recreate texture views each time to avoid reuse issues
    // WebGPU texture views cannot be reused after being submitted
    const colorView = this.colorTexture.createView();
    const depthView = this.depthTexture.createView();

    // Render picker pass
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0.0,  // Reverse-Z: clear to 0.0 (far plane)
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // Resize buffer if needed (safety net for very large models)
    if (drawables.length > this.maxMeshes) {
      this.resizeExpressIdBuffer(drawables.length);
    }

    // Build mesh index array (index + 1, so 0 = no hit)
    // Using mesh index instead of expressId to properly support multi-model with overlapping expressIds
    const meshIndexArray = new Uint32Array(drawables.length);
    for (let i = 0; i < drawables.length; i++) {
      if (drawables[i]) {
        meshIndexArray[i] = i + 1;  // +1 so 0 means no hit
      }
    }
    this.device.queue.writeBuffer(this.expressIdBuffer, 0, meshIndexArray);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);

    // Draw each mesh with its index as the first instance
    // The shader will use this instance_index to look up the expressId
    for (let i = 0; i < drawables.length; i++) {
      const d = drawables[i];
      if (!d) continue;

      const uniformData = new Float32Array(32);
      uniformData.set(viewProj, 0);
      uniformData.set(d.transform.m, 16);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

      pass.setVertexBuffer(0, d.vertexBuffer);
      pass.setIndexBuffer(d.indexBuffer, 'uint32');
      // Draw 1 instance, starting at instance i (so instance_index = i in shader)
      pass.drawIndexed(d.indexCount, 1, d.firstIndex, d.baseVertex, i);
    }

    pass.end();

    // Read pixel at click position
    // WebGPU requires bytesPerRow to be a multiple of 256
    const BYTES_PER_ROW = 256;
    const readBuffer = this.device.createBuffer({
      size: BYTES_PER_ROW,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer(
      {
        texture: this.colorTexture,
        origin: { x: Math.floor(x), y: Math.floor(y), z: 0 },
      },
      {
        buffer: readBuffer,
        bytesPerRow: BYTES_PER_ROW,
        rowsPerImage: 1,
      },
      { width: 1, height: 1 }
    );

    this.device.queue.submit([encoder.finish()]);
    // GPUMapMode.READ = 1 (WebGPU spec)
    await readBuffer.mapAsync(1); // GPUMapMode.READ
    const data = new Uint32Array(readBuffer.getMappedRange());
    const meshIndex = data[0];
    readBuffer.unmap();
    readBuffer.destroy();

    // meshIndex is (actual index + 1), so 0 = no hit
    if (meshIndex === 0) return null;

    // Look up the mesh to get both expressId and modelIndex
    const drawable = drawables[meshIndex - 1];
    if (!drawable) return null;

    return {
      expressId: drawable.expressId,
      modelIndex: drawable.modelIndex,
    };
  }

  updateUniforms(viewProj: Float32Array): void {
    // Update viewProj matrix only
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
  }

  /**
   * Resize expressId buffer to accommodate more meshes
   */
  private resizeExpressIdBuffer(newSize: number): void {
    // Destroy old buffer
    this.expressIdBuffer.destroy();

    // Increase maxMeshes with 50% headroom for future growth
    this.maxMeshes = Math.ceil(newSize * 1.5);

    // Create new buffer
    this.expressIdBuffer = this.device.createBuffer({
      size: this.maxMeshes * 4, // 4 bytes per u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Recreate bind group with new buffer
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.expressIdBuffer },
        },
      ],
    });
  }
}
