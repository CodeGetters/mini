/**
 * ====================================================================
 *
 * @file 事件绑定的更新
 *
 * 1、给元素缓存一个绑定的事件列表
 * 2、如果缓存中没有且 value 有值，则添加事件
 *    a.在创建事件 handler 时，invoker 会将 value 放入 invoker.value 中，同时也会记录当前时间
 *    b.记录的时间在同一个 tick 中会获取到同一个时间戳（使用Promise.resolve()、逗号运算符进行了缓存）
 * 3、如果缓存中有且 value 为空，则移除事件并清除缓存
 * 4、缓存中有且 value 有值，则更新事件
 * 5、在获取事件名称时，会根据情况解析事件名称--->on:click|onClick-->click
 *
 * 涉及正则：匹配大写字母 /\B([A-Z])/g | 匹配连字符+小写字母 /-(\W)/g
 *
 * ====================================================================
 */
import { hyphenate, isArray } from "@mini/shared";
import { ErrorCodes, callWithAsyncErrorHandling } from "../errorHandling";

interface Invoker extends EventListener {
  value: EventValue;
  attached: number;
}

type EventValue = Function | Function[];

const veiKey: unique symbol = Symbol("_vei");

export function patchEvent(el: Element, rawName, nextValue): void {
  // 对函数进行缓存
  const invokers = el[veiKey] || (el[veiKey] = {});
  const existingInvoker = invokers[rawName];

  // 如果存在事件，并且 nextValue 不为空，那么更新事件
  if (existingInvoker && nextValue) {
    existingInvoker.value = nextValue;
  } else {
    const [name, options] = parseName(rawName);
    // console.log("============patchEvent=========", name, options);
    // 如果 nextValue 不为空，那么添加事件
    if (nextValue) {
      const invoker = (invokers[rawName] = createInvoker(
        nextValue as EventValue
      ));
      addEventListener(el, name, invoker, options);
    } else {
      // 如果 nextValue 为空，那么移除事件同时清除缓存
      removeEventListener(el, name, existingInvoker, options);
      invokers[rawName] = undefined;
    }
  }
}

let cachedNow: number = 0;
const p = /*@__PURE__*/ Promise.resolve();
/**
 * 在同一个 tick 缓存使用同一个时间戳以避免多次调用 Date.now 造成的性能开销(同一个 tick：一个宏任务和其带来的微任务)
 * 判断 cachedNow 是否为 0
 *     1.若 cacheNow 不为 0 ，则直接使用缓存的值
 *     2.否则执行右侧表达式：
 * 使用 p.then 注册一个回调，该回调会在 Promise.resolve() 完成后执行，然后将 cachedNow 重置为 0
 * cachedNow 在下一个 tick 会被重置为 0（Promise.resolve().then(()=>...)）
 *
 * 逗号运算符：在一个表达式中，逗号运算符将从左到右依次计算每个子表达式，并返回最后一个子表达式的值
 * ```js
 * let y = 0;
 * y = (y += 1, y += 2, y += 3);
 * console.log(y); // 输出 6
 * ```
 */
const getNow = () =>
  cachedNow || (p.then(() => (cachedNow = 0)), (cachedNow = Date.now()));

/**
 * 解析事件名称
 * 处理两种事件名称格式：
 * name = 'on:click'-->click
 * name = 'click'-->click
 *
 * @param name 原始事件名称
 * @returns [事件名称, 事件选项]
 */
function parseName(name: string): [string, EventListenerOptions | undefined] {
  let options: EventListenerOptions | undefined;
  const event = name[2] === ":" ? name.slice(3) : hyphenate(name.slice(2));
  // TODO：对于事件修饰符不做处理
  // eg：Once|Passive|Capture
  return [event, options];
}

/**
 * 创建一个事件调用器
 * @param initialValue 初始事件值
 * @param instance 实例（可选）
 * @returns 返回一个事件调用器函数
 */
function createInvoker(initialValue: EventValue, instance?) {
  const invoker: Invoker = (e: Event & { _vts?: number }) => {
    // 如果事件没有时间戳，则添加一个
    // 内部点击事件会由于浏览器的事件传播机制触发 tick 从而触发补丁（patch）操作。
    // 这里给每一个事件添加一个时间戳，以避免不一致的事件时间戳导致的补丁操作
    if (!e._vts) {
      e._vts = Date.now();
    } else if (e._vts < invoker.attached) {
      // 如果事件的时间戳早于或等于调用器的附加时间，则忽略该事件
      return;
    }
    callWithAsyncErrorHandling(
      patchStopImmediatePropagation(e, invoker.value),
      instance,
      ErrorCodes.NATIVE_EVENT_HANDLER,
      [e]
    );
  };
  invoker.value = initialValue;
  // 设置调用器的附加时间为当前时间
  invoker.attached = getNow();
  return invoker;
}

/**
 * 添加事件监听器
 * @param el 要添加事件监听器的元素
 * @param event 事件名称
 * @param handler 事件处理函数
 * @param options 可选的事件监听器选项
 */
export function addEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.addEventListener(event, handler, options);
}

/**
 * 移除事件监听器
 * @param el 要移除事件监听器的元素
 * @param event 事件名称
 * @param handler 事件处理函数
 * @param options 可选的事件监听器选项
 */
export function removeEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.removeEventListener(event, handler, options);
}

/**
 * 修补事件的 stopImmediatePropagation 方法
 * @param e 事件对象
 * @param value 事件处理函数或函数数组
 * @returns 修补后的事件处理函数或函数数组
 */
function patchStopImmediatePropagation(
  e: Event,
  value: EventValue
): EventValue {
  if (isArray(value)) {
    // 保存原始的 stopImmediatePropagation 方法
    const originalStop = e.stopImmediatePropagation;
    // 重写 stopImmediatePropagation 方法
    e.stopImmediatePropagation = () => {
      originalStop.call(e);
      (e as any)._stopped = true;
    };
    // 对数组中的每个函数进行包装，检查事件是否已停止
    return (value as Function[]).map(
      (fn) => (e: Event) => !(e as any)._stopped && fn(e)
    );
  } else {
    // 如果 value 不是数组，直接返回
    return value;
  }
}
